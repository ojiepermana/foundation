import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { groupAlive } from '../../../scripts/lib/process-identity.ts';
import { SIGNAL_CLEANUP_LIMIT_MS, signalCallTimeout } from '../../orchestration/signal-cleanup.ts';
import { removeWorkspaces, workspace } from './workspace.ts';

// GATE-009 (spec 0010, AC-4 and AC-8, row *Pembersihan sinyal suite nyata*): SIGINT or SIGTERM to a `bun test` process
// runs every callback registered on tests/orchestration/signal-cleanup.ts, in reverse order of registration and in two
// passes, then exits 130 or 143 without returning to test code. The fixture runs without Docker: two `bun:test` files
// written at runtime in a `mkdtemp` workspace import the module by absolute path, and a fake `docker` at the front of
// PATH logs its arguments. The proof on the real Docker daemon is the verification of build plan step 3.

afterEach(removeWorkspaces);

const root = resolve(import.meta.dir, '../../..');
const modulePath = join(root, 'tests/orchestration/signal-cleanup.ts');

/**
 * Fake `docker`: logs each call as `<arguments>|<present or absent>`, the state of the folder `FAKE_DOCKER_WATCH` at that
 * moment. `run` waits; it logs only once its trap is set, so the signal never comes before it can be handled, and after
 * the signal it lingers one more second, longer than the synchronous cleanup, so the test code of `bun test` could only
 * go on if the handler returned to it. The trap stops the background `sleep`, which a non interactive shell starts with
 * SIGINT ignored. `rm -f <FAKE_DOCKER_FAIL>` exits 1 with text on stderr that must never reach the output of the handler.
 */
const fakeDocker = `#!/bin/sh
state=absent
if [ -d "$FAKE_DOCKER_WATCH" ]; then state=present; fi
case "$1" in
  run)
    sleep 30 &
    pid=$!
    trap 'kill "$pid" 2>/dev/null; sleep 1; exit 143' TERM INT
    printf '%s|%s\\n' "$*" "$state" >> "$FAKE_DOCKER_LOG"
    wait "$pid"
    exit 0
    ;;
esac
printf '%s|%s\\n' "$*" "$state" >> "$FAKE_DOCKER_LOG"
case "$1" in
  rm)
    if [ -n "$FAKE_DOCKER_FAIL" ] && [ "$3" = "$FAKE_DOCKER_FAIL" ]; then
      echo "fake daemon detail for $3" >&2
      exit 1
    fi
    ;;
esac
exit 0
`;

/** Callbacks shared by both fixture files, written the way the real suites write theirs. */
const fixtureHelpers = `
import { mkdirSync, rmSync } from 'node:fs';
import { onSignalCleanup, type SignalCleanupCallback } from ${JSON.stringify(modulePath)};
export { onSignalCleanup };
export const fixtureRoot = process.env.FIXTURE_ROOT!;
export function container(name: string): SignalCleanupCallback {
  return ({ timeout }) => {
    const limit = timeout(30000);
    if (limit <= 0) return [name];
    const result = Bun.spawnSync(['docker', 'rm', '-f', name], { env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: limit });
    return result.exitCode === 0 ? [] : [name];
  };
}
export function folder(path: string): SignalCleanupCallback {
  return ({ pass }) => {
    if (pass !== 2) return [];
    rmSync(path, { recursive: true, force: true });
    return [];
  };
}
export function makeFolder(path: string): void {
  mkdirSync(path);
}
export function removeFolder(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
`;

/** First file: a folder and a container removed by the normal path and released, then a container that stays registered. */
const firstFile = `
import { test } from 'bun:test';
import { container, fixtureRoot, folder, makeFolder, onSignalCleanup, removeFolder } from './helpers.ts';
test('first file registers, releases, and keeps one container', () => {
  const path = fixtureRoot + '/a-folder';
  const releaseFolder = onSignalCleanup(folder(path));
  makeFolder(path);
  const releaseContainer = onSignalCleanup(container('fixture-a-released'));
  removeFolder(path);
  releaseContainer();
  releaseFolder();
  onSignalCleanup(container('fixture-a-kept'));
  if (process.env.FIXTURE_THROW === '1') {
    onSignalCleanup(() => {
      throw new Error('fixture callback detail');
    });
  }
});
`;

/** Second file: a folder, then a container, then a `docker run` that waits until the signal. */
const secondFile = `
import { test } from 'bun:test';
import { container, fixtureRoot, folder, makeFolder, onSignalCleanup } from './helpers.ts';
const quiet = { env: process.env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' } as const;
test('second file waits on docker run', async () => {
  const path = fixtureRoot + '/b-folder';
  onSignalCleanup(folder(path));
  makeFolder(path);
  onSignalCleanup(container('fixture-b-kept'));
  await Bun.spawn(['docker', 'run', '--name', 'fixture-b-kept', 'fixture-image'], quiet).exited;
  // Reached only when the handler returned to test code: it would create a container after the signal.
  await Bun.spawn(['docker', 'run', '--name', 'fixture-b-after', 'fixture-image'], quiet).exited;
}, 60000);
`;

type Run = { code: number | null; stderr: string; log: string[]; root: string };

async function waitUntil(check: () => Promise<boolean>, limitMs: number): Promise<boolean> {
  for (const deadline = Date.now() + limitMs; Date.now() < deadline; await Bun.sleep(50)) {
    if (await check()) return true;
  }
  return false;
}

async function readLog(path: string): Promise<string[]> {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}

/**
 * Runs `bun test` on both fixture files as the leader of its own process group, sends `signal` to that group once the
 * fake `docker run` waits, and returns after every process of the group is gone.
 */
async function interruptedRun(signal: 'SIGHUP' | 'SIGINT' | 'SIGTERM', extra: Record<string, string> = {}): Promise<Run> {
  const dir = await workspace({ 'helpers.ts': fixtureHelpers, 'a.test.ts': firstFile, 'b.test.ts': secondFile, 'bin/docker': fakeDocker });
  await chmod(join(dir, 'bin/docker'), 0o755);
  const log = join(dir, 'docker.log');
  const env: Record<string, string> = {
    PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`,
    HOME: process.env['HOME'] ?? dir,
    TMPDIR: dir,
    FIXTURE_ROOT: dir,
    FAKE_DOCKER_LOG: log,
    FAKE_DOCKER_WATCH: join(dir, 'b-folder'),
    ...extra,
  };
  const child = spawn(process.execPath, ['--no-env-file', 'test', './a.test.ts', './b.test.ts'], {
    cwd: dir, env, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  const pgid = child.pid!;
  try {
    const waiting = await waitUntil(async () => (await readLog(log)).some((line) => line.startsWith('run ')), 20_000);
    expect(waiting).toBe(true);
    process.kill(-pgid, signal);
    const code = await exited;
    expect(await waitUntil(async () => !(await groupAlive(pgid)), 10_000)).toBe(true);
    return { code, stderr: Buffer.concat(stderr).toString('utf8'), log: await readLog(log), root: dir };
  } finally {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
  }
}

const removals = (log: string[], name: string) => log.filter((line) => line.startsWith(`rm -f ${name}|`)).length;
const failureLines = (stderr: string) => stderr.split('\n').filter((line) => line.startsWith('Pembersihan sinyal gagal'));

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

/** The checks every interrupted run shares, with or without a failing name. */
async function expectCleanedInReverseOrder(run: Run): Promise<void> {
  // rm -f twice for every name not released, including the one of the first file, never for the released name.
  expect(removals(run.log, 'fixture-b-kept')).toBe(2);
  expect(removals(run.log, 'fixture-a-kept')).toBe(2);
  expect(removals(run.log, 'fixture-a-released')).toBe(0);
  // One docker run, before the signal, and nothing created after it.
  const runs = run.log.filter((line) => line.startsWith('run '));
  expect(runs).toEqual(['run --name fixture-b-kept fixture-image|present']);
  // Reverse order of registration, in two passes; the folder of the second file still exists on the pass 2 removal of
  // its container, and is gone afterwards.
  expect(run.log.slice(1).map((line) => line.split('|')[0])).toEqual([
    'rm -f fixture-b-kept', 'rm -f fixture-a-kept', 'rm -f fixture-b-kept', 'rm -f fixture-a-kept',
  ]);
  expect(run.log[3]).toBe('rm -f fixture-b-kept|present');
  expect(run.log[4]).toBe('rm -f fixture-a-kept|absent');
  expect(await exists(join(run.root, 'b-folder'))).toBe(false);
  expect(await exists(join(run.root, 'a-folder'))).toBe(false);
}

test('GATE-009 SIGTERM to bun test removes every registered resource in reverse order, in two passes, and exits 143', async () => {
  const run = await interruptedRun('SIGTERM');
  expect(run.code).toBe(143);
  await expectCleanedInReverseOrder(run);
  expect(failureLines(run.stderr)).toEqual([]);
}, 60_000);

test('GATE-009 SIGINT to bun test runs the same cleanup and exits 130', async () => {
  const run = await interruptedRun('SIGINT');
  expect(run.code).toBe(130);
  await expectCleanedInReverseOrder(run);
  expect(failureLines(run.stderr)).toEqual([]);
}, 60_000);

test('GATE-009 SIGHUP to bun test, as from a terminal that closed, runs the same cleanup and exits 129', async () => {
  const run = await interruptedRun('SIGHUP');
  expect(run.code).toBe(129);
  await expectCleanedInReverseOrder(run);
  expect(failureLines(run.stderr)).toEqual([]);
}, 60_000);

test('GATE-009 a name Docker fails to remove and a callback that throws give one stderr line with names only', async () => {
  const run = await interruptedRun('SIGTERM', { FAKE_DOCKER_FAIL: 'fixture-a-kept', FIXTURE_THROW: '1' });
  expect(run.code).toBe(143);
  // The throwing callback runs between the second file and fixture-a-kept, and does not stop the callbacks after it.
  await expectCleanedInReverseOrder(run);
  expect(failureLines(run.stderr)).toEqual(['Pembersihan sinyal gagal: callback, fixture-a-kept']);
  expect(run.stderr).not.toContain('fake daemon detail');
  expect(run.stderr).not.toContain('fixture callback detail');
}, 60_000);

test('GATE-009 signalCallTimeout gives the call limit, cut by what is left of 60000 ms, and 0 once nothing is left', () => {
  expect(SIGNAL_CLEANUP_LIMIT_MS).toBe(60_000);
  expect(signalCallTimeout(1_000, 1_000, 45_000)).toBe(45_000);
  expect(signalCallTimeout(1_000, 21_000, 30_000)).toBe(30_000);
  expect(signalCallTimeout(1_000, 46_000, 30_000)).toBe(15_000);
  expect(signalCallTimeout(1_000, 60_999, 30_000)).toBe(1);
  expect(signalCallTimeout(1_000, 61_000, 30_000)).toBe(0);
  expect(signalCallTimeout(1_000, 90_000, 30_000)).toBe(0);
  // performance.now() has a fraction, and Bun.spawnSync refuses a timeout that is not an integer.
  expect(signalCallTimeout(0.5, 30_000.25, 45_000)).toBe(30_000);
  expect(signalCallTimeout(0.5, 60_000.25, 45_000)).toBe(0);
  expect(signalCallTimeout(100.75, 200.5, 45_000)).toBe(45_000);
});

/** True when one import of `file` resolves to tests/orchestration/signal-cleanup.ts, read with the TypeScript parser. */
function importsSignalCleanup(file: string, text: string): boolean {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return source.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return false;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) return false;
    const target = resolve(dirname(join(root, file)), specifier);
    return relative(modulePath, target) === '' || relative(modulePath, `${target}.ts`) === '';
  });
}

test('GATE-009 every real bun:test file that runs Docker imports the signal cleanup module', async () => {
  const checked: string[] = [];
  for (const folder of ['tests/integration/infrastructure', 'tests/integration/database']) {
    for (const name of await readdir(join(root, folder), { recursive: true })) {
      if (!name.endsWith('.test.ts')) continue;
      const file = `${folder}/${name}`;
      const text = await readFile(join(root, file), 'utf8');
      if (!text.includes("'docker'") && !text.includes('"docker"')) continue;
      checked.push(file);
      expect(importsSignalCleanup(file, text), `${file} imports tests/orchestration/signal-cleanup.ts`).toBe(true);
    }
  }
  expect(checked.sort()).toEqual([
    'tests/integration/database/health.test.ts',
    'tests/integration/database/migration.test.ts',
    'tests/integration/database/provision.test.ts',
    'tests/integration/database/readiness.test.ts',
    'tests/integration/infrastructure/postgres.test.ts',
  ]);
});

/** `graceMs` of the object argument of a call, as a number; `undefined` when the call passes none. */
function graceOf(call: ts.CallExpression): number | undefined {
  for (const argument of call.arguments) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property) || property.name.getText() !== 'graceMs') continue;
      return ts.isNumericLiteral(property.initializer) ? Number(property.initializer.text.replaceAll('_', '')) : Number.NaN;
    }
  }
  return undefined;
}

/** The calls whose first argument is an array literal holding the string literal `marker`. */
function callsWith(source: ts.SourceFile, marker: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      if (first && ts.isArrayLiteralExpression(first) && first.elements.some((element) => ts.isStringLiteral(element) && element.text === marker)) {
        found.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test('GATE-009 test:database:real gives its bun test group 75000 ms after SIGTERM and keeps the default for the build', async () => {
  const file = 'tests/orchestration/database-real.ts';
  const source = ts.createSourceFile(file, await readFile(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const tests = callsWith(source, 'test');
  expect(tests).toHaveLength(1);
  expect(graceOf(tests[0]!)).toBe(75_000);
  const builds = callsWith(source, 'build:frontend');
  expect(builds).toHaveLength(1);
  expect(graceOf(builds[0]!)).toBeUndefined();
});

// ---------------------------------------------------------------------------------------------------------------
// Added by the review fixes (spec 0010): the real suites themselves. The import alone proves nothing about the callbacks,
// so the suites run here with a fake `docker` and are stopped with SIGTERM while their own `docker run` or Compose build
// waits, and a source check reads where each suite registers and releases its resources.

/**
 * Fake `docker` for the real suites. It answers the availability probes of the infrastructure suite and the label checks
 * of the readiness guard, and waits on `docker run` and on `compose ... build postgres` (its trap is set before it logs
 * `waiting`). After the signal that wait lingers one more second, as in the fake above: Bun may resume test code when
 * a child it awaits exits before Bun runs the signal handler, and the normal path of the suite (`finally`, `afterAll`,
 * or the `beforeAll` catch) would then add its own removal call to the log, so the log would not show the handler
 * alone. Each call is logged as `<arguments>|<foundation-* entries of the fixture TMPDIR>`, so the log shows whether a
 * folder still existed at that moment. It finds its log and that TMPDIR next to itself, because readiness.test.ts gives
 * Docker an environment of its own.
 */
const suiteFakeDocker = `#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
log="$here/../docker.log"
state=$(cd "$here/../tmp" && ls -d foundation-* 2>/dev/null | tr '\\n' ' ' | sed 's/ $//')
printf '%s|%s\\n' "$*" "$state" >> "$log"
case "$*" in
  "compose version") echo 'Docker Compose version v2'; exit 0 ;;
  "compose up --help") echo '      --wait    Wait for services'; exit 0 ;;
  "info --format {{.ServerVersion}}") echo '29.0.0'; exit 0 ;;
  "image inspect --format {{json .Config.Labels}} "*) echo 'null'; exit 0 ;;
  "container inspect --format {{json .Config.Labels}} "*) echo '{"foundation.test":"readiness"}'; exit 0 ;;
  run\\ *|*" build postgres")
    sleep 60 &
    pid=$!
    trap 'kill "$pid" 2>/dev/null; sleep 1; exit 143' TERM INT HUP
    printf 'waiting\\n' >> "$log"
    wait "$pid"
    exit 0
    ;;
esac
exit 0
`;

type SuiteRun = { code: number | null; stderr: string; created: string; folder: string; after: string[]; left: string[] };

/**
 * Runs one real suite of the repository (only the tests matching `filter` when given) with the fake `docker` first on
 * PATH and TMPDIR in the fixture, sends SIGTERM to its group once a Docker call waits, and returns the call that waited,
 * the folder that existed then, every call after the signal, and the foundation-* entries left in TMPDIR.
 */
async function interruptedSuite(file: string, filter?: string): Promise<SuiteRun> {
  const dir = await workspace({ 'bin/docker': suiteFakeDocker });
  await chmod(join(dir, 'bin/docker'), 0o755);
  const tmp = join(dir, 'tmp');
  await mkdir(tmp);
  const log = join(dir, 'docker.log');
  const env = { PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`, HOME: process.env['HOME'] ?? dir, TMPDIR: tmp };
  const args = ['--no-env-file', 'test', `./${file}`, ...(filter === undefined ? [] : ['-t', filter])];
  const child = spawn(process.execPath, args, { cwd: root, env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  const pgid = child.pid!;
  try {
    expect(await waitUntil(async () => (await readLog(log)).includes('waiting'), 30_000), `${file} reached a waiting Docker call`).toBe(true);
    process.kill(-pgid, 'SIGTERM');
    const code = await exited;
    expect(await waitUntil(async () => !(await groupAlive(pgid)), 10_000)).toBe(true);
    const lines = await readLog(log);
    const waiting = lines.indexOf('waiting');
    const [created = '', folder = ''] = (lines[waiting - 1] ?? '').split('|');
    const left = (await readdir(tmp)).filter((name) => name.startsWith('foundation-'));
    return { code, stderr: Buffer.concat(stderr).toString('utf8'), created, folder, after: lines.slice(waiting + 1), left };
  } finally {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
  }
}

/** The checks every interrupted real suite shares: exit 143, no failure line, and its folder gone at the end. */
function expectSuiteCleaned(run: SuiteRun, folderPattern: RegExp): void {
  expect(run.code).toBe(143);
  expect(failureLines(run.stderr)).toEqual([]);
  expect(run.folder).toMatch(folderPattern);
  expect(run.left).toEqual([]);
}

test('GATE-009 SIGTERM to the infrastructure suite runs compose down for its project on both passes, checks the project labels, then removes its folder', async () => {
  // covers: AC-4 (Pembersihan sinyal suite nyata: postgres.test.ts, project Compose dan folder workspace)
  const run = await interruptedSuite('tests/integration/infrastructure/postgres.test.ts', 'INFRA-002 build terkunci');
  expectSuiteCleaned(run, /^foundation-infra-test-\w{6}$/);
  const [, project, envFile] = /^compose -p (foundation-infra-test-[0-9a-f]{8}) --env-file (\S+) -f docker-compose\.yml -f tests\/integration\/infrastructure\/compose\.test\.yml build postgres$/.exec(run.created) ?? [];
  expect(project).toBeDefined();
  expect(envFile).toEndWith(`/${run.folder}/${project}.env`);
  const down = `compose -p ${project} --env-file ${envFile} -f docker-compose.yml -f tests/integration/infrastructure/compose.test.yml down --volumes --remove-orphans`;
  const filter = `--filter label=com.docker.compose.project=${project}`;
  // The folder that holds the env file is still there for every Compose call, and removed only after them.
  expect(run.after).toEqual([down, down, `ps -aq ${filter}`, `network ls -q ${filter}`, `volume ls -q ${filter}`].map((line) => `${line}|${run.folder}`));
}, 60_000);

test('GATE-009 SIGTERM to the provision, migration, readiness, and health suites removes the container they started on both passes, then its folder', async () => {
  // covers: AC-4 (Pembersihan sinyal suite nyata: provision.test.ts, migration.test.ts, readiness.test.ts, health.test.ts)
  const suites = [
    ['tests/integration/database/provision.test.ts', undefined, /^foundation-db-test-\w{6}$/, /^run --rm -d --name (foundation-db-test-[0-9a-f]{8}) /, false],
    ['tests/integration/database/migration.test.ts', 'MIG-001', /^foundation-migration-\w{6}$/, /^run --rm -d --name (foundation-mig-test-[0-9a-f]{8}) /, false],
    ['tests/integration/database/readiness.test.ts', undefined, /^foundation-readiness-test-\w{6}$/, /^run -d --name (foundation-readiness-db-[0-9a-f]{8}) /, true],
    // DEP-009 of spec 0012 uses the READY-008 harness: the same guarded container, with a folder of its own.
    ['tests/integration/database/health.test.ts', undefined, /^foundation-health-test-\w{6}$/, /^run -d --name (foundation-readiness-db-[0-9a-f]{8}) /, true],
  ] as const;
  for (const [file, filter, folderPattern, started, guarded] of suites) {
    const run = await interruptedSuite(file, filter);
    expectSuiteCleaned(run, folderPattern);
    const name = started.exec(run.created)?.[1];
    expect(name, file).toBeDefined();
    // READY-008 removes its container through the guard of spec 0006: inspect the labels, then rm -f.
    const pass = guarded ? [`container inspect --format {{json .Config.Labels}} ${name}`, `rm -f ${name}`] : [`rm -f ${name}`];
    expect(run.after, file).toEqual([...pass, ...pass].map((line) => `${line}|${run.folder}`));
  }
}, 120_000);

const REAL_SUITES = [
  'tests/integration/database/health.test.ts',
  'tests/integration/database/migration.test.ts',
  'tests/integration/database/provision.test.ts',
  'tests/integration/database/readiness.test.ts',
  'tests/integration/infrastructure/postgres.test.ts',
];

function sourceOf(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function allCalls(node: ts.Node): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (current: ts.Node) => {
    if (ts.isCallExpression(current)) found.push(current);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/** The name a call is made through: `f` for `f(...)` and `x.f(...)`, otherwise an empty string. */
function calleeName(call: ts.CallExpression): string {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return '';
}

/** The elements of the first array literal argument of `call`, as text for string literals and `null` for the rest. */
function arrayArgument(call: ts.CallExpression): Array<string | null> {
  const array = call.arguments.find(ts.isArrayLiteralExpression);
  return array === undefined ? [] : array.elements.map((element) => (ts.isStringLiteralLike(element) ? element.text : null));
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) if (ts.isFunctionLike(current)) return current;
  return undefined;
}

/** Calls inside the function around `call` that end before `call` starts. */
function callsBefore(call: ts.CallExpression): ts.CallExpression[] {
  const scope = enclosingFunction(call);
  return scope === undefined ? [] : allCalls(scope).filter((other) => other.getEnd() <= call.getStart());
}

/** A `docker run`, or a Compose call that creates (`up`, `build`, `run`, `create`, `start`), given as an argument array. */
function createsDockerResource(call: ts.CallExpression): boolean {
  const [first, second, ...rest] = arrayArgument(call);
  if (first !== 'docker') return false;
  if (second === 'run') return true;
  return second === 'compose' && !rest.includes('--help') && rest.some((item) => item !== null && ['up', 'build', 'run', 'create', 'start'].includes(item));
}

/** A call that removes what a release function takes off the registry. */
function removes(call: ts.CallExpression): boolean {
  const name = calleeName(call);
  const args = arrayArgument(call);
  if (['rm', 'rmSync', 'kill', 'stopBackend', 'removeStack'].includes(name)) return true;
  if (name === 'guardedDocker') return ts.isStringLiteralLike(call.arguments[0]!) && (call.arguments[0] as ts.StringLiteral).text === 'rm';
  if (name === 'compose') return args[0] === 'down';
  // `docker rm -f <name>`, or a `docker run --rm` in the foreground (no `-d`), whose container is gone once it returns.
  return args[0] === 'docker' && (args[1] === 'rm' || (args[1] === 'run' && args.includes('--rm') && !args.includes('-d')));
}

test('GATE-009 every real suite registers its cleanup before each Docker resource it creates and releases it only after the normal removal', async () => {
  // covers: AC-4 (setiap file bun:test nyata mendaftarkan resource sebelum dibuat dan melepasnya sesudah jalur normal)
  for (const file of REAL_SUITES) {
    const source = sourceOf(file, await readFile(join(root, file), 'utf8'));
    const calls = allCalls(source);
    const creations = calls.filter(createsDockerResource);
    for (const creation of creations) {
      const where = `${file}:${source.getLineAndCharacterOfPosition(creation.getStart()).line + 1}`;
      expect(callsBefore(creation).some((call) => calleeName(call) === 'onSignalCleanup'), `${where} registers before it creates`).toBe(true);
    }
    const releases = calls.filter((call) => /^release(?:[A-Z]\w*)?$/.test(calleeName(call)) && ts.isIdentifier(call.expression));
    expect(releases.length, `${file} releases what it registered`).toBeGreaterThan(0);
    for (const release of releases) {
      const where = `${file}:${source.getLineAndCharacterOfPosition(release.getStart()).line + 1}`;
      expect(callsBefore(release).some(removes), `${where} releases after a removal`).toBe(true);
    }
  }

  // Compose projects of the infrastructure suite exist only through createStack, which registers the project after its
  // env file is written and before it returns, so no Compose command for that project can come before the registration.
  const file = 'tests/integration/infrastructure/postgres.test.ts';
  const source = sourceOf(file, await readFile(join(root, file), 'utf8'));
  const createStack = source.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === 'createStack');
  expect(createStack).toBeDefined();
  const inside = allCalls(createStack!);
  const register = inside.find((call) => calleeName(call) === 'onSignalCleanup' && call.arguments.some((argument) => ts.isCallExpression(argument) && calleeName(argument) === 'stackCleanup'));
  const envFile = inside.find((call) => calleeName(call) === 'writeFile');
  expect(register).toBeDefined();
  expect(envFile!.getEnd()).toBeLessThanOrEqual(register!.getStart());
  const stacks: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const names = node.properties.map((property) => property.name?.getText() ?? '');
      if (names.includes('project') && names.includes('envFile')) stacks.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(stacks.length).toBeGreaterThan(0);
  for (const stack of stacks) expect(enclosingFunction(stack)).toBe(createStack);
  // The compose helper refuses a project outside the test prefix before it calls Docker.
  const composeHelper = source.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === 'compose');
  expect(allCalls(composeHelper!).map(calleeName)[0]).toBe('assertTestProject');
});
