import { lstat, readFile } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import ts from 'typescript';
import { TIERS, tierSteps, type Tier, type TierName } from './gate.ts';
import { registryFiles } from './registry-reader.ts';
import { ownersOf, RUNNER_OWNERS, type RunnerOwner } from './test-inventory.ts';

export {
  readRegistries,
  REGISTRY_DIR,
  RegistryError,
  registryFiles,
  type Registry,
  type RegistryCheck,
  type RegistryScenario,
} from './registry-reader.ts';

// Scenario registries of spec 0010 (AC-2): `tests/scenarios/*.json` in one fixed shape. `validateRegistries` checks
// every rule and returns every violation at once, with the registry path and the scenario ID but never the content of a
// file; `test:scenarios` runs it before the suites. `readRegistries` (in `registry-reader.ts`, which needs no installed
// package) gives the gate report the same registries. A test tag counts only as a string literal read with the
// TypeScript parser that is already installed, so a tag in a comment does not count; the JUnit of the run proves the
// title again in the report.

export const SCENARIO_ID = /^[A-Z]+-\d{3}$/;
export const CRITERION = /^AC-\d+$/;
export const CHECK_RUNNERS = ['bun:test', 'vitest', 'playwright', 'command'] as const;
export type CheckRunner = (typeof CHECK_RUNNERS)[number];

const SOURCE_ROOTS = ['docs/specs/', 'docs/rules/'];
const REGISTRY_FIELDS = new Set(['source', 'scenarios']);
const SCENARIO_FIELDS = new Set(['id', 'criteria', 'critical', 'checks']);
const CHECK_FIELDS = new Set(['runner', 'script', 'file', 'testTag']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

// ---------------------------------------------------------------------------------------------------------------
// Sources, files, and literals.

/** The criteria a source defines: list items (after `-` or `N.`) that start with `**AC-n**:`. */
export function definedCriteria(text: string): Set<string> {
  const found = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:-|\d+\.)\s+\*\*(AC-\d+)\*\*:/.exec(line);
    if (match?.[1] !== undefined) found.add(match[1]);
  }
  return found;
}

/** A relative repository path in canonical form: no empty, `.`, or `..` segment, no backslash, no NUL. */
export function repositoryPath(path: unknown): path is string {
  if (typeof path !== 'string' || path === '' || isAbsolute(path) || path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export type FileState = 'regular' | 'missing' | 'symlink' | 'not_regular';

/** Whether `path` is a regular file under `root`, checking every segment so a symlinked folder is caught too. */
export async function fileState(root: string, path: string): Promise<FileState> {
  const segments = path.split('/');
  for (let index = 1; index <= segments.length; index += 1) {
    let info;
    try {
      info = await lstat(join(root, ...segments.slice(0, index)));
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return 'missing';
      throw error;
    }
    if (info.isSymbolicLink()) return 'symlink';
    if (index === segments.length) return info.isFile() ? 'regular' : 'not_regular';
  }
  return 'missing';
}

const scriptKinds: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
};

/**
 * Every string literal, template without substitution, and template head in `text`, read with `ts.createSourceFile`.
 * Comments are not nodes, so a tag that only appears in a comment is not returned.
 */
export function stringLiterals(fileName: string, text: string): string[] {
  const kind = scriptKinds[extname(fileName).toLowerCase()] ?? ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** True when one literal starts with `<tag>` followed by a space. */
export function hasTagLiteral(literals: readonly string[], tag: string): boolean {
  return literals.some((literal) => literal.startsWith(`${tag} `));
}

// ---------------------------------------------------------------------------------------------------------------
// Validation (AC-2).

export type Violation = { registry: string; id: string | null; message: string };

export type ValidationResult = { violations: Violation[]; ids: number; checks: number };

export type ValidationOptions = {
  root: string;
  /** The tier table; the exported one by default. */
  tiers?: Readonly<Partial<Record<TierName, Tier>>>;
  /** The runner owner table; the exported one by default. */
  owners?: readonly RunnerOwner[];
};

/** Registry values in a message: plain when they look like a name or a path, otherwise quoted and cut. */
function shown(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  if (/^[\w@./:+-]{1,120}$/.test(text)) return text;
  return JSON.stringify(Array.from(text).slice(0, 60).join(''));
}

type Pending = { registry: string; id: string | null; scenario: Record<string, unknown>; source: string | null; criteria: Set<string> | null };

async function readSource(root: string, registry: string, source: unknown, report: (message: string) => void): Promise<{ path: string; criteria: Set<string> } | null> {
  if (!repositoryPath(source) || !SOURCE_ROOTS.some((prefix) => source.startsWith(prefix))) {
    report('source wajib path relatif di docs/specs/ atau docs/rules/');
    return null;
  }
  const state = await fileState(root, source);
  if (state !== 'regular') {
    report(`source ${shown(source)} ${state === 'symlink' ? 'berupa symlink' : state === 'missing' ? 'tidak ada' : 'bukan file reguler'}`);
    return null;
  }
  return { path: source, criteria: definedCriteria(await readFile(join(root, source), 'utf8')) };
}

/**
 * Validates every registry under `root` against the rules of AC-2 and returns every violation at once. Nothing of a
 * test file or a source is ever put in a message; only registry paths, IDs, field names, scripts, and paths are.
 */
export async function validateRegistries(options: ValidationOptions): Promise<ValidationResult> {
  const { root } = options;
  const steps = tierSteps(options.tiers ?? TIERS);
  const tierRoots = new Set(Object.values(options.tiers ?? TIERS).map((tier) => tier?.script));
  const owners = options.owners ?? RUNNER_OWNERS;
  const violations: Violation[] = [];

  let scripts: Record<string, unknown> = {};
  try {
    const manifest: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (isRecord(manifest) && isRecord(manifest['scripts'])) scripts = manifest['scripts'];
    else violations.push({ registry: 'package.json', id: null, message: 'package.json tidak mempunyai scripts' });
  } catch {
    violations.push({ registry: 'package.json', id: null, message: 'package.json tidak dapat dibaca' });
  }

  // Pass 1: shapes, sources, IDs, and criteria; every ID is known before any testTag is checked.
  const firstSeen = new Map<string, string>();
  const pending: Pending[] = [];
  for (const registry of await registryFiles(root)) {
    const report = (message: string, id: string | null = null) => violations.push({ registry, id, message });
    if ((await fileState(root, registry)) !== 'regular') {
      report('registry bukan file reguler');
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(root, registry), 'utf8'));
    } catch {
      report('JSON tidak valid');
      continue;
    }
    if (!isRecord(raw)) {
      report('registry wajib berupa objek');
      continue;
    }
    for (const key of Object.keys(raw)) if (!REGISTRY_FIELDS.has(key)) report(`field registry tidak dikenal ${shown(key)}`);
    const source = await readSource(root, registry, raw['source'], report);
    if (!Array.isArray(raw['scenarios'])) {
      report('scenarios wajib berupa array');
      continue;
    }
    raw['scenarios'].forEach((scenario: unknown, index: number) => {
      if (!isRecord(scenario)) {
        report(`skenario ke-${index + 1} bukan objek`);
        return;
      }
      const rawId = scenario['id'];
      let id: string | null = null;
      if (typeof rawId === 'string' && SCENARIO_ID.test(rawId)) {
        id = rawId;
        const earlier = firstSeen.get(rawId);
        if (earlier !== undefined) report(`ID ganda, sudah terdaftar di ${earlier}`, id);
        else firstSeen.set(rawId, registry);
      } else {
        report(`ID skenario ke-${index + 1} ${shown(rawId)} tidak cocok ${SCENARIO_ID.source}`);
      }
      pending.push({ registry, id, scenario, source: source?.path ?? null, criteria: source?.criteria ?? null });
    });
  }

  // Pass 2: fields, criteria, checks, and the critical rule.
  const literalCache = new Map<string, string[]>();
  let checkCount = 0;
  for (const { registry, id, scenario, source, criteria } of pending) {
    const report = (message: string) => violations.push({ registry, id, message });
    for (const key of Object.keys(scenario)) {
      if (SCENARIO_FIELDS.has(key)) continue;
      if (CHECK_FIELDS.has(key)) report(`bentuk inline tidak diizinkan (${key}); pakai checks`);
      else report(`field skenario tidak dikenal ${shown(key)}`);
    }

    const list = scenario['criteria'];
    if (!Array.isArray(list) || list.length === 0) report('criteria wajib array yang tidak kosong');
    else {
      for (const criterion of list) {
        if (typeof criterion !== 'string' || !CRITERION.test(criterion)) report(`kriteria ${shown(criterion)} tidak cocok ${CRITERION.source}`);
        else if (criteria !== null && !criteria.has(criterion)) report(`kriteria ${criterion} bukan butir **${criterion}**: di ${source}`);
      }
    }
    if (Object.hasOwn(scenario, 'critical') && typeof scenario['critical'] !== 'boolean') report('critical wajib boolean');

    const checks = scenario['checks'];
    if (!Array.isArray(checks) || checks.length === 0) {
      report('checks wajib array yang tidak kosong');
      continue;
    }
    let criticalPlaywright = false;
    for (const [index, check] of checks.entries()) {
      const label = `check ke-${index + 1}`;
      if (!isRecord(check)) {
        report(`${label} bukan objek`);
        continue;
      }
      checkCount += 1;
      for (const key of Object.keys(check)) if (!CHECK_FIELDS.has(key)) report(`${label}: field tidak dikenal ${shown(key)}`);
      const runner = check['runner'];
      const script = check['script'];
      const file = check['file'];
      const tag = check['testTag'];
      const known = typeof runner === 'string' && (CHECK_RUNNERS as readonly string[]).includes(runner);
      if (!known) report(`${label}: runner ${shown(runner)} tidak dikenal`);
      const command = runner === 'command';

      let scriptValid = false;
      if (typeof script !== 'string' || script === '') report(`${label}: script wajib diisi`);
      else if (!Object.hasOwn(scripts, script)) report(`${label}: script ${shown(script)} tidak ada di package.json`);
      else if (!steps.has(script) && !(command && tierRoots.has(script))) report(`${label}: script ${shown(script)} bukan langkah tier gate`);
      else scriptValid = true;

      let fileValid = false;
      if (!repositoryPath(file)) report(`${label}: file wajib path relatif di dalam repository tanpa ..`);
      else {
        const state = await fileState(root, file);
        if (state === 'regular') fileValid = true;
        else report(`${label}: file ${shown(file)} ${state === 'symlink' ? 'berupa symlink' : state === 'missing' ? 'tidak ada' : 'bukan file reguler'}`);
      }

      if (tag !== undefined && (typeof tag !== 'string' || !firstSeen.has(tag))) report(`${label}: testTag ${shown(tag)} bukan ID terdaftar`);
      if (!known || command) continue;
      if (tag === undefined) report(`${label}: testTag wajib untuk runner ${runner}`);

      if (scriptValid && typeof file === 'string' && repositoryPath(file)) {
        const owner = ownersOf(file, owners).find((candidate) => candidate.script === script);
        if (owner === undefined) report(`${label}: file ${shown(file)} tidak dimiliki ${script} menurut tabel pemilik runner`);
        else if (owner.runner !== runner) report(`${label}: runner ${runner} tidak cocok dengan pemilik ${script} (${owner.runner})`);
      }
      if (fileValid && typeof file === 'string' && typeof tag === 'string' && firstSeen.has(tag)) {
        let literals = literalCache.get(file);
        if (literals === undefined) {
          literals = stringLiterals(file, await readFile(join(root, file), 'utf8'));
          literalCache.set(file, literals);
        }
        if (!hasTagLiteral(literals, tag)) report(`${label}: file ${file} tidak memuat literal string yang diawali "${tag} "`);
      }
      if (runner === 'playwright' && scriptValid && steps.has(script as string)) criticalPlaywright = true;
    }
    if (scenario['critical'] === true && !criticalPlaywright) report('skenario critical tanpa check playwright pada script tier');
  }

  return { violations, ids: firstSeen.size, checks: checkCount };
}

export function formatViolation(violation: Violation): string {
  return `${violation.registry} ${violation.id ?? '-'}: ${violation.message}`;
}

/** `test:scenarios`: validates every registry, prints every violation on its own line, and resolves to the exit code. */
export async function runScenarioValidation(
  root: string,
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  error: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  const result = await validateRegistries({ root });
  if (result.violations.length > 0) {
    error(`Validasi registry skenario gagal dengan ${result.violations.length} pelanggaran:`);
    for (const violation of result.violations) error(`  ${formatViolation(violation)}`);
    return 1;
  }
  log(`Scenario registries passed (${result.ids} unique IDs, ${result.checks} checks).`);
  return 0;
}
