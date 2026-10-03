import { builtinModules } from 'node:module';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, relative, resolve, join } from 'node:path';
import * as ts from 'typescript';

const forbiddenBuiltins = new Set(builtinModules.map((specifier) => specifier.replace(/^node:/, '')));

export type FrontendBundleOptions = {
  applicationSource: string;
  outputDirectory: string;
  environment?: Record<string, string | undefined>;
};

function forbiddenSpecifier(specifier: string): boolean {
  const normalized = specifier.replace(/^node:/, '');
  return (
    specifier === '@sdk' ||
    specifier.startsWith('@sdk/') ||
    specifier.startsWith('node:') ||
    specifier.startsWith('bun:') ||
    specifier === 'bun' ||
    specifier.startsWith('bun/') ||
    forbiddenBuiltins.has(normalized) ||
    /(?:^|[/@])(?:backend|worker|server)(?:[/@]|$)/i.test(specifier) ||
    /(?:^|\/)(?:apps\/(?:backend|worker)|libs\/server)(?:\/|$)/i.test(specifier)
  );
}

function stringSpecifier(node: ts.Expression | ts.TypeNode | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteralLike(node.literal)) return node.literal.text;
  return undefined;
}

export function hasForbiddenBrowserImport(source: string, fileName = 'browser-source.ts'): boolean {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let forbidden = false;

  const inspect = (specifier: string | undefined) => {
    if (specifier === undefined || forbiddenSpecifier(specifier)) forbidden = true;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) inspect(stringSpecifier(node.moduleSpecifier));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      inspect(stringSpecifier(node.moduleReference.expression));
    } else if (ts.isImportTypeNode(node)) {
      inspect(stringSpecifier(node.argument));
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) inspect(stringSpecifier(node.arguments[0]));
    }

    if (!forbidden) ts.forEachChild(node, visit);
  };

  visit(file);
  return forbidden;
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files;
}

async function assertApplicationImportsAreBrowserSafe(applicationSource: string): Promise<void> {
  const files = (await collectFiles(applicationSource)).filter(
    (path) => ['.ts', '.tsx'].includes(extname(path)) && !/\.(?:spec|test)\.tsx?$/.test(path),
  );

  for (const path of files) {
    const source = await readFile(path, 'utf8');
    if (hasForbiddenBrowserImport(source, path)) {
      throw new Error(`Browser application imports a server only module from ${relative(process.cwd(), path)}.`);
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
    throw new Error('Build the frontend before checking its production assets.');
  }

  const assets = (await collectFiles(outputDirectory)).filter((path) =>
    ['.css', '.html', '.js', '.mjs'].includes(extname(path)),
  );
  if (!assets.some((path) => path.endsWith('index.html'))) {
    throw new Error('Production frontend index.html was not found in the build output.');
  }

  const credentials = configuredCredentialValues(environment);
  const databaseUrl = /postgres(?:ql)?:\/\/[^\s'"`<>]+/i;
  const privateKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

  for (const path of assets) {
    const asset = await readFile(path, 'utf8');
    if (databaseUrl.test(asset) || privateKey.test(asset) || credentials.some((value) => asset.includes(value))) {
      throw new Error(`A database URL or configured credential was found in ${relative(process.cwd(), path)}.`);
    }
  }
}

export async function checkFrontendBundle(options: FrontendBundleOptions): Promise<void> {
  await assertApplicationImportsAreBrowserSafe(resolve(options.applicationSource));
  await assertProductionAssetsAreSafe(resolve(options.outputDirectory), options.environment ?? {});
}
