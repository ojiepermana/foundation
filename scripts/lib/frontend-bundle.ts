import { builtinModules } from 'node:module';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve, join, sep } from 'node:path';
import * as ts from 'typescript';
import { formatArtifactPath } from './api-artifacts.ts';

const forbiddenBuiltins = new Set(builtinModules.map((specifier) => specifier.replace(/^node:/, '')));

// Folder name rule for `app/features/<fitur>/<fitur>-api.ts` adapters (spec 0009, AC-3).
const featureName = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export type FrontendBundleOptions = {
  applicationSource: string;
  outputDirectory: string;
  environment?: Record<string, string | undefined>;
};

/**
 * A checker failure whose message is fixed text plus, at most, a path relative to the working directory.
 * The CLI prints only this message; any other error becomes `Frontend bundle check failed.`.
 */
export class FrontendBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontendBundleError';
  }
}

/**
 * How a file may use the SDK barrel (spec 0009, *Bentuk impor SDK*): `adapter` is
 * `app/features/<fitur>/<fitur>-api.ts`, `config` is `app/app.config.ts`, and `other` is every other file.
 */
export type SdkImportRole = 'adapter' | 'config' | 'other';

export type BrowserImportViolation = 'server' | 'sdk';

export type BrowserImportContext = {
  role: SdkImportRole;
  /** Absolute path of the generated SDK folder, `resolve(applicationSource, '../sdk')`. */
  sdkDirectory: string;
};

/** Role of a file from its path relative to the application source root, written with `/`. */
export function sdkImportRole(relativePath: string): SdkImportRole {
  if (relativePath === 'app/app.config.ts') return 'config';
  const parts = relativePath.split('/');
  const [app, features, feature, file] = parts;
  if (
    parts.length === 4 &&
    app === 'app' &&
    features === 'features' &&
    feature !== undefined &&
    featureName.test(feature) &&
    file === `${feature}-api.ts`
  ) {
    return 'adapter';
  }
  return 'other';
}

function serverOnlySpecifier(specifier: string): boolean {
  const normalized = specifier.replace(/^node:/, '');
  return (
    specifier.startsWith('node:') ||
    specifier.startsWith('bun:') ||
    specifier === 'bun' ||
    specifier.startsWith('bun/') ||
    forbiddenBuiltins.has(normalized) ||
    /(?:^|[/@])(?:backend|worker|server)(?:[/@]|$)/i.test(specifier) ||
    /(?:^|\/)(?:apps\/(?:backend|worker)|libs\/server)(?:\/|$)/i.test(specifier)
  );
}

function relativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * `barrel` is the `@sdk` alias itself. `inside` is `@sdk/...` or a relative specifier that resolves to the SDK
 * folder or a path inside it; those are rejected in every file.
 */
function sdkSpecifier(specifier: string, fileName: string, sdkDirectory: string): 'barrel' | 'inside' | undefined {
  if (specifier === '@sdk') return 'barrel';
  if (specifier.startsWith('@sdk/')) return 'inside';
  if (relativeSpecifier(specifier)) {
    const target = resolve(dirname(fileName), specifier);
    if (target === sdkDirectory || target.startsWith(sdkDirectory + sep)) return 'inside';
  }
  return undefined;
}

function stringSpecifier(node: ts.Expression | ts.TypeNode | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteralLike(node.literal)) return node.literal.text;
  return undefined;
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** Local names bound by top level `@sdk` imports, so later local re-exports of them can be rejected. */
function sdkBindings(file: ts.SourceFile, fileName: string, sdkDirectory: string): Set<string> {
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = stringSpecifier(statement.moduleSpecifier);
    if (specifier === undefined || sdkSpecifier(specifier, fileName, sdkDirectory) === undefined) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) names.add(element.name.text);
  }
  return names;
}

/** `import { A, type B } from '@sdk'` and `import type { A } from '@sdk'`, with at least one name. */
function acceptedBarrelImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause || clause.name) return false;
  const bindings = clause.namedBindings;
  return bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length > 0;
}

/** `export type { A } from '@sdk'`, with at least one name. */
function acceptedBarrelTypeExport(node: ts.ExportDeclaration): boolean {
  const clause = node.exportClause;
  return node.isTypeOnly && clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0;
}

/**
 * First import or export violation in source order, or `undefined` when the file follows the rules.
 * `server` covers server only modules and specifiers that cannot be inspected; `sdk` covers the SDK import table.
 */
export function findBrowserImportViolation(
  source: string,
  fileName: string,
  context: BrowserImportContext,
): BrowserImportViolation | undefined {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const { role, sdkDirectory } = context;
  const mayUseBarrel = role !== 'other';
  const bindings = mayUseBarrel ? sdkBindings(file, fileName, sdkDirectory) : new Set<string>();
  let violation: BrowserImportViolation | undefined;

  // Classifies one module specifier. `barrel` returns `undefined` so the caller applies the form rules.
  const inspect = (specifier: string | undefined): BrowserImportViolation | 'barrel' | undefined => {
    if (specifier === undefined) return 'server';
    const sdk = sdkSpecifier(specifier, fileName, sdkDirectory);
    if (sdk === 'inside') return 'sdk';
    if (sdk === 'barrel') return 'barrel';
    return serverOnlySpecifier(specifier) ? 'server' : undefined;
  };

  const exportsSdkBinding = (name: string | undefined) => name !== undefined && bindings.has(name);

  const check = (node: ts.Node): BrowserImportViolation | undefined => {
    if (ts.isImportDeclaration(node)) {
      const result = inspect(stringSpecifier(node.moduleSpecifier));
      if (result !== 'barrel') return result;
      return mayUseBarrel && acceptedBarrelImport(node) ? undefined : 'sdk';
    }
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        const result = inspect(stringSpecifier(node.moduleSpecifier));
        if (result !== 'barrel') return result;
        return role === 'adapter' && acceptedBarrelTypeExport(node) ? undefined : 'sdk';
      }
      const clause = node.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        const local = clause.elements.some((element) => exportsSdkBinding((element.propertyName ?? element.name).text));
        if (local) return 'sdk';
      }
      return undefined;
    }
    if (ts.isExportAssignment(node)) {
      const expression = unwrapParentheses(node.expression);
      return ts.isIdentifier(expression) && exportsSdkBinding(expression.text) ? 'sdk' : undefined;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        const result = inspect(stringSpecifier(node.moduleReference.expression));
        return result === 'barrel' ? 'sdk' : result;
      }
      const exported = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      let entity: ts.EntityName = node.moduleReference;
      while (ts.isQualifiedName(entity)) entity = entity.left;
      return exported && exportsSdkBinding(entity.text) ? 'sdk' : undefined;
    }
    if (ts.isImportTypeNode(node)) {
      const result = inspect(stringSpecifier(node.argument));
      return result === 'barrel' ? 'sdk' : result;
    }
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const result = inspect(stringSpecifier(node.arguments[0]));
        return result === 'barrel' ? 'sdk' : result;
      }
    }
    return undefined;
  };

  const visit = (node: ts.Node): void => {
    if (violation) return;
    violation = check(node);
    if (!violation) ts.forEachChild(node, visit);
  };

  visit(file);
  return violation;
}

/**
 * The path relative to the working directory with `/`, escaped like `api:check` report paths, so a file name with a
 * newline or a control character cannot add a line to the output.
 */
function displayPath(path: string): string {
  return formatArtifactPath(relative(process.cwd(), path).split(sep).join('/'));
}

function codeUnitOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type CollectedFiles = { files: string[]; symlinks: string[] };

/** Regular files and symlinks below `directory`; symlinks are listed, never followed. */
async function collectFiles(directory: string, collected: CollectedFiles = { files: [], symlinks: [] }): Promise<CollectedFiles> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) collected.symlinks.push(path);
    else if (entry.isDirectory()) await collectFiles(path, collected);
    else if (entry.isFile()) collected.files.push(path);
  }
  return collected;
}

/**
 * The checker reads files without following links, while the Angular build follows them, so a symlinked file or
 * folder would be built without being checked. The first symlink in code unit order of its path fails the check.
 */
function rejectSymlinks(symlinks: string[]): void {
  const [first] = [...symlinks].sort(codeUnitOrder);
  if (first !== undefined) {
    throw new FrontendBundleError(`Frontend bundle check does not follow the symlink ${displayPath(first)}.`);
  }
}

async function assertApplicationImportsAreBrowserSafe(applicationSource: string): Promise<void> {
  const sdkDirectory = resolve(applicationSource, '../sdk');
  const collected = await collectFiles(applicationSource);
  rejectSymlinks(collected.symlinks);
  const files = collected.files
    .filter((path) => ['.ts', '.tsx'].includes(extname(path)) && !/\.(?:spec|test)\.tsx?$/.test(path))
    .map((path) => ({ path, relativePath: relative(applicationSource, path).split(sep).join('/') }))
    .sort((left, right) => codeUnitOrder(left.relativePath, right.relativePath));

  for (const { path, relativePath } of files) {
    const source = await readFile(path, 'utf8');
    const violation = findBrowserImportViolation(source, path, { role: sdkImportRole(relativePath), sdkDirectory });
    if (violation === 'server') {
      throw new FrontendBundleError(`Browser application imports a server only module from ${displayPath(path)}.`);
    }
    if (violation === 'sdk') {
      throw new FrontendBundleError(`Browser application imports the SDK outside a feature adapter from ${displayPath(path)}.`);
    }
  }
}

function configuredCredentialValues(environment: Record<string, string | undefined>): string[] {
  return Object.entries(environment)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        /(?:DATABASE_URL|DB_URL|DSN|PASSWORD|PASSWD|SECRET|CREDENTIAL|TOKEN|PRIVATE_KEY|ACCESS_KEY)/i.test(key) &&
        value.trim().length >= 8,
    )
    .flatMap(([, value]) => {
      const trimmed = value!.trim();
      return [trimmed, encodeURIComponent(trimmed)];
    });
}

async function assertProductionAssetsAreSafe(
  outputDirectory: string,
  environment: Record<string, string | undefined>,
): Promise<void> {
  const outputStat = await stat(outputDirectory).catch(() => null);
  if (!outputStat?.isDirectory()) {
    throw new FrontendBundleError('Build the frontend before checking its production assets.');
  }

  const collected = await collectFiles(outputDirectory);
  rejectSymlinks(collected.symlinks);
  const assets = collected.files.filter((path) => ['.css', '.html', '.js', '.mjs'].includes(extname(path)));
  if (!assets.some((path) => path.endsWith('index.html'))) {
    throw new FrontendBundleError('Production frontend index.html was not found in the build output.');
  }

  const credentials = configuredCredentialValues(environment);
  const databaseUrl = /postgres(?:ql)?:\/\/[^\s'"`<>]+/i;
  const privateKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

  for (const path of assets) {
    const asset = await readFile(path, 'utf8');
    if (databaseUrl.test(asset) || privateKey.test(asset) || credentials.some((value) => asset.includes(value))) {
      throw new FrontendBundleError(`A database URL or configured credential was found in ${displayPath(path)}.`);
    }
  }
}

export async function checkFrontendBundle(options: FrontendBundleOptions): Promise<void> {
  await assertApplicationImportsAreBrowserSafe(resolve(options.applicationSource));
  await assertProductionAssetsAreSafe(resolve(options.outputDirectory), options.environment ?? {});
}
