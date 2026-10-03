import { expect, test } from 'bun:test';
import { ChildProcess, spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readdir, readlink, realpath, rename, rm, stat, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as ts from 'typescript';
import globalSetup, {
  sdkContractBackendEnvironment,
  startSdkContractBackend,
} from '../../../apps/frontend/vitest-backend.setup.ts';
import {
  API_INPUTS,
  copyApiInputs,
  diffArtifacts,
  emptyDiff,
  formatArtifactPath,
  formatDiffLines,
  readArtifacts,
  type ArtifactDiff,
} from '../../../scripts/lib/api-artifacts.ts';
import { canonicalJson } from '../../../scripts/lib/canonical-json.ts';
import { runProcessGroup } from '../../../scripts/lib/process-group.ts';
import { checkoutSnapshot, copyFrontendApplication, root, run, runBun, workspace } from './workspace.ts';

// SDK contract scenarios of spec 0009 that run under Bun. The Vitest half of SDK-004 lives in
// apps/frontend/src/app/sdk-contract.integration.spec.ts and runs through `bun run test:frontend`.

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function failedStart(command: readonly string[], readyTimeoutMs?: number) {
  const attempts: Array<{ attempt: number; pid: number | undefined }> = [];
  const lines: string[] = [];
  const error = await startSdkContractBackend({
    command,
    readyTimeoutMs,
    onAttempt: (attempt, pid) => attempts.push({ attempt, pid }),
    log: (line) => lines.push(line),
  }).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  return { error, attempts, lines };
}

test('SDK-004 sdkContractBackendEnvironment passes exactly PATH, HOME, NODE_ENV, HOST, and PORT', () => {
  const environment = sdkContractBackendEnvironment(
    {
      PATH: '/fixture/bin',
      HOME: '/fixture/home',
      DATABASE_URL: 'not-a-url',
      FOUNDATION_TEST_SECRET: 'sentinel-sdk-004',
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: '1',
    },
    43_210,
  );
  expect(environment).toStrictEqual({
    PATH: '/fixture/bin',
    HOME: '/fixture/home',
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: '43210',
  });
  expect(Object.keys(environment)).toHaveLength(5);
});

test('SDK-004 startSdkContractBackend gives up after three attempts when the command does not exist', async () => {
  const { error, attempts, lines } = await failedStart(['foundation-sdk-contract-missing-command']);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe('SDK contract backend did not start');
  expect(attempts.map(({ attempt }) => attempt)).toEqual([1, 2, 3]);
  for (const { pid } of attempts) if (pid !== undefined) expect(processGone(pid)).toBe(true);
  expect(lines).toEqual([]);
}, 30_000);

test('SDK-004 startSdkContractBackend gives up after three attempts when the command exits before it is ready', async () => {
  const { error, attempts, lines } = await failedStart(['sh', '-c', 'exit 1']);
  expect((error as Error).message).toBe('SDK contract backend did not start');
  expect(attempts.map(({ attempt }) => attempt)).toEqual([1, 2, 3]);
  for (const { pid } of attempts) {
    expect(pid).toBeNumber();
    expect(processGone(pid!)).toBe(true);
  }
  expect(lines).toEqual([]);
}, 30_000);

test('SDK-004 startSdkContractBackend stops a child that never becomes ready before the next attempt', async () => {
  const { error, attempts } = await failedStart([process.execPath, '-e', 'setInterval(() => {}, 1000)'], 500);
  expect((error as Error).message).toBe('SDK contract backend did not start');
  expect(attempts).toHaveLength(3);
  for (const { pid } of attempts) {
    expect(pid).toBeNumber();
    expect(processGone(pid!)).toBe(true);
  }
}, 30_000);

test('SDK-004 startSdkContractBackend is not ready for a 200 JSON body other than {"status":"ok"}', async () => {
  const server = (body: string) =>
    `Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch: () => Response.json(${body}) });`;

  // Control: the same stand in server with the exact body is ready inside the same window.
  const lines: string[] = [];
  const control = await startSdkContractBackend({
    command: [process.execPath, '-e', server("{ status: 'ok' }")],
    readyTimeoutMs: 1_500,
    log: (line) => lines.push(line),
  });
  await control.stop();
  expect(lines).toEqual([`SDK contract backend listening on 127.0.0.1:${control.port}`, 'SDK contract backend stopped']);

  const { error, attempts } = await failedStart([process.execPath, '-e', server("{ status: 'ok', extra: 1 }")], 1_500);
  expect((error as Error).message).toBe('SDK contract backend did not start');
  expect(attempts).toHaveLength(3);
  for (const { pid } of attempts) {
    expect(pid).toBeNumber();
    expect(processGone(pid!)).toBe(true);
  }
}, 30_000);

test('SDK-004 startSdkContractBackend serves the real backend on loopback and closes the port on stop', async () => {
  const pids: Array<number | undefined> = [];
  const lines: string[] = [];
  const backend = await startSdkContractBackend({ onAttempt: (_attempt, pid) => pids.push(pid), log: (line) => lines.push(line) });
  try {
    expect(backend.url).toBe(`http://127.0.0.1:${backend.port}`);
    expect(lines).toEqual([`SDK contract backend listening on 127.0.0.1:${backend.port}`]);
    const response = await fetch(`${backend.url}/api/status`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"status":"ok"}');
  } finally {
    await backend.stop();
  }
  expect(lines).toEqual([`SDK contract backend listening on 127.0.0.1:${backend.port}`, 'SDK contract backend stopped']);
  const afterStop = await fetch(`${backend.url}/api/status`).then(
    () => 'answered',
    () => 'refused',
  );
  expect(afterStop).toBe('refused');
  expect(pids).toHaveLength(1);
  expect(processGone(pids[0]!)).toBe(true);
}, 30_000);

type SetupProject = Parameters<typeof globalSetup>[0];

/** A stand in for the Vitest project: records what `globalSetup` gives it through `provide`. */
function recordingProject(): { project: SetupProject; provided: Map<string, unknown> } {
  const provided = new Map<string, unknown>();
  const project = { provide: (key: string, value: unknown) => void provided.set(key, value) } as unknown as SetupProject;
  return { project, provided };
}

/** `answered` when something accepts the connection at `url`, `refused` otherwise. */
function reach(url: string): Promise<'answered' | 'refused'> {
  return fetch(`${url}/api/status`, { signal: AbortSignal.timeout(2_000) }).then(
    () => 'answered' as const,
    () => 'refused' as const,
  );
}

// covers: AC-4 ("tepat satu backend nyata dimulai untuk seluruh run", "Setiap pemanggilan globalSetup memberikan
// sdkContractBackendUrl dan sdkContractClosedUrl", the *Satu backend per run* row), without relying on how many
// times a given Angular version calls the setup.
test('SDK-004 globalSetup shares one backend between concurrent setup calls, provides both URLs to each, and stops it at the last teardown', async () => {
  const stateKey = Symbol.for('foundation.sdkContractBackend');
  const store = globalThis as unknown as Record<symbol, unknown>;
  expect(store[stateKey]).toBeUndefined();
  const written: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  const harnessLines = () => written.join('').split('\n').filter((line) => line.startsWith('SDK contract backend'));
  const pending: Array<() => Promise<void>> = [];
  try {
    const frontend = recordingProject();
    const rootProject = recordingProject();
    // Both calls start before either awaits, as Vitest does for the project and the root config.
    const teardowns = await Promise.all([globalSetup(frontend.project), globalSetup(rootProject.project)]);
    pending.push(...teardowns);

    const backendUrl = frontend.provided.get('sdkContractBackendUrl');
    const closedUrl = frontend.provided.get('sdkContractClosedUrl');
    expect(backendUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(closedUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(closedUrl).not.toBe(backendUrl);
    expect([...rootProject.provided.entries()]).toEqual([...frontend.provided.entries()]);
    expect(harnessLines()).toEqual([`SDK contract backend listening on ${String(backendUrl).slice('http://'.length)}`]);

    const response = await fetch(`${backendUrl}/api/status`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"status":"ok"}');
    expect(await reach(String(closedUrl))).toBe('refused');

    // Teardown runs in reverse order; the first one keeps the backend for the remaining user.
    await pending.pop()!();
    expect(await reach(String(backendUrl))).toBe('answered');
    expect(harnessLines()).toHaveLength(1);
    expect(store[stateKey]).toBeDefined();

    await pending.pop()!();
    expect(harnessLines()).toEqual([
      `SDK contract backend listening on ${String(backendUrl).slice('http://'.length)}`,
      'SDK contract backend stopped',
    ]);
    expect(await reach(String(backendUrl))).toBe('refused');
    expect(store[stateKey]).toBeUndefined();

    // A later run in the same process starts its own backend instead of reusing the stopped one.
    const later = recordingProject();
    pending.push(await globalSetup(later.project));
    const laterUrl = String(later.provided.get('sdkContractBackendUrl'));
    expect(await reach(laterUrl)).toBe('answered');
    await pending.pop()!();
    expect(await reach(laterUrl)).toBe('refused');
    expect(harnessLines().filter((line) => line.startsWith('SDK contract backend listening on '))).toHaveLength(2);
    expect(harnessLines().filter((line) => line === 'SDK contract backend stopped')).toHaveLength(2);
  } finally {
    process.stdout.write = originalWrite;
    for (const teardown of pending.reverse()) await teardown().catch(() => undefined);
    delete store[stateKey];
  }
}, 60_000);

// covers: review finding, Vitest calls no teardown for a setup that threw, and the rejected state stayed in
// globalThis, so every later setup in the same process failed at once without starting a backend.
test('SDK-004 globalSetup forgets a failed start, so the next setup in the same process starts a new backend', async () => {
  const stateKey = Symbol.for('foundation.sdkContractBackend');
  const store = globalThis as unknown as Record<symbol, unknown>;
  expect(store[stateKey]).toBeUndefined();
  const path = process.env['PATH'];
  const originalWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  let teardown: (() => Promise<void>) | undefined;
  try {
    // Without bun on PATH every attempt fails to spawn, the same failure a missing runtime gives in CI.
    process.env['PATH'] = '/nonexistent';
    const failed = await globalSetup(recordingProject().project).then(
      () => undefined,
      (error: unknown) => error,
    );
    process.env['PATH'] = path;
    expect((failed as Error).message).toBe('SDK contract backend did not start');
    expect(store[stateKey]).toBeUndefined();

    const later = recordingProject();
    teardown = await globalSetup(later.project);
    const url = String(later.provided.get('sdkContractBackendUrl'));
    expect(await reach(url)).toBe('answered');
    const stop = teardown;
    teardown = undefined;
    await stop();
    expect(await reach(url)).toBe('refused');
  } finally {
    process.env['PATH'] = path;
    process.stdout.write = originalWrite;
    if (teardown) await teardown().catch(() => undefined);
    delete store[stateKey];
  }
}, 60_000);

// covers: review finding, the 5 second wait timer of stop() was never cleared and held the Vitest process open after
// teardown. The probe prints the time stop() resolved; the process must end soon after, not one grace period later.
test('SDK-004 stop() lets the process that started the backend exit at once instead of after the 5 second grace period', async () => {
  const server = `Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch: () => Response.json({ status: 'ok' }) });`;
  const probe = [
    `import { startSdkContractBackend } from ${JSON.stringify(join(root, 'apps/frontend/vitest-backend.setup.ts'))};`,
    `const backend = await startSdkContractBackend({ command: [process.execPath, '-e', ${JSON.stringify(server)}], log: () => {} });`,
    'await backend.stop();',
    'process.stdout.write(`stopped ${Date.now()}\\n`);',
  ].join('\n');
  const child = start([process.execPath, '--no-env-file', '-e', probe], root, { PATH: process.env['PATH']!, HOME: process.env['HOME']! });
  const result = await child.finished;
  const closed = Date.now();
  expect(result.code, result.stderr).toBe(0);
  const stopped = Number(result.stdout.match(/^stopped (\d+)$/m)?.[1]);
  expect(stopped).toBeGreaterThan(0);
  expect(closed - stopped).toBeLessThan(2_000);
}, 30_000);

// covers: the *Penghentian* row of the harness: a child still running 5 seconds after SIGKILL makes the harness throw
// `SDK contract backend did not stop`. `ChildProcess.prototype.kill` becomes a no op for this test, so the real child
// outlives both signals; the test kills it directly afterwards.
test('SDK-004 startSdkContractBackend throws SDK contract backend did not stop when the child outlives SIGTERM and SIGKILL', async () => {
  const originalKill = ChildProcess.prototype.kill;
  const pids: number[] = [];
  ChildProcess.prototype.kill = function kill() {
    return true;
  };
  try {
    const started = performance.now();
    const error = await startSdkContractBackend({
      command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      readyTimeoutMs: 200,
      onAttempt: (_attempt, pid) => {
        if (pid !== undefined) pids.push(pid);
      },
      log: () => undefined,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect((error as Error).message).toBe('SDK contract backend did not stop');
    // The first attempt already failed to stop, so no second attempt started.
    expect(pids).toHaveLength(1);
    expect(processGone(pids[0]!)).toBe(false);
    expect(performance.now() - started).toBeGreaterThanOrEqual(9_900);
  } finally {
    ChildProcess.prototype.kill = originalKill;
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
  const deadline = performance.now() + 5_000;
  while (!processGone(pids[0]!) && performance.now() < deadline) await Bun.sleep(50);
  expect(processGone(pids[0]!)).toBe(true);
}, 30_000);

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers for the api:check scenarios (SDK-006, SDK-007, SDK-010) and the SDK-004 workspace run.

const reportLine = /^(added|changed|removed) |^\.\.\. and \d+ more /;
const checkTimeoutMs = 150_000;
const heavyTestTimeoutMs = 180_000;

function outputLines(text: string): string[] {
  return text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line !== '');
}

function reportLines(stderr: string): string[] {
  return outputLines(stderr).filter((line) => reportLine.test(line));
}

/** Exactly `expected` as report lines, directly followed by the fixed `message`, which appears once. */
function expectReport(stderr: string, expected: string[], message: string): void {
  const lines = outputLines(stderr);
  expect(lines.filter((line) => reportLine.test(line))).toEqual(expected);
  const at = lines.indexOf(message);
  expect(at).toBeGreaterThanOrEqual(0);
  expect(lines.lastIndexOf(message)).toBe(at);
  expect(lines.slice(at - expected.length, at)).toEqual(expected);
}

/** Dead means not in the process table, or a zombie, the same rule `groupAlive` uses. */
function processDead(pid: number): boolean {
  const ps = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'stat='], { stdout: 'pipe', stderr: 'ignore' });
  const stat = ps.stdout.toString().trim();
  return stat === '' || stat.startsWith('Z');
}

function scratch(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function marker(name: string): string {
  return `${name}${crypto.randomUUID().replaceAll('-', '')}`;
}

// ---------------------------------------------------------------------------------------------------------------
// SDK-006 (AC-6): readArtifacts, diffArtifacts, and formatDiffLines.

test('SDK-006 readArtifacts reads entries with lstat, never follows symlinks or opens a FIFO, and ignores empty directories', async () => {
  const dir = await scratch('foundation-sdk-006-read-');
  try {
    const sdk = join(dir, 'apps/frontend/sdk');
    await mkdir(join(sdk, 'nested'), { recursive: true });
    await mkdir(join(sdk, 'empty/deeper'), { recursive: true });
    await Bun.write(join(dir, 'openapi.json'), '{}\n');
    await Bun.write(join(sdk, 'api.ts'), 'export {};\n');
    await Bun.write(join(sdk, 'nested/model.ts'), 'export type Model = string;\n');
    await Bun.write(join(dir, 'outside-marker.txt'), 'outside\n');
    await symlink('../../../outside-marker.txt', join(sdk, 'linked.ts'));
    expect(Bun.spawnSync(['mkfifo', join(sdk, 'pipe')]).exitCode).toBe(0);

    const entries = await readArtifacts(dir);
    expect([...entries.keys()].sort()).toEqual([
      'apps/frontend/sdk/api.ts',
      'apps/frontend/sdk/linked.ts',
      'apps/frontend/sdk/nested/model.ts',
      'apps/frontend/sdk/pipe',
      'openapi.json',
    ]);
    expect(entries.get('openapi.json')).toEqual({ kind: 'file', size: 3 });
    expect(entries.get('apps/frontend/sdk/api.ts')).toEqual({ kind: 'file', size: 11 });
    expect(entries.get('apps/frontend/sdk/linked.ts')).toEqual({ kind: 'other' });
    expect(entries.get('apps/frontend/sdk/pipe')).toEqual({ kind: 'other' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test('SDK-006 readArtifacts treats an SDK folder reached through a symlink as one other entry and reads nothing behind it', async () => {
  const dir = await scratch('foundation-sdk-006-root-');
  try {
    const target = join(dir, 'elsewhere');
    await mkdir(target);
    await Bun.write(join(target, 'marker-inside.ts'), 'marker\n');
    await mkdir(join(dir, 'apps/frontend'), { recursive: true });
    await symlink(target, join(dir, 'apps/frontend/sdk'));
    expect([...(await readArtifacts(dir)).entries()]).toEqual([['apps/frontend/sdk', { kind: 'other' }]]);

    await rm(join(dir, 'apps'), { recursive: true });
    await mkdir(join(dir, 'real/sdk'), { recursive: true });
    await Bun.write(join(dir, 'real/sdk/marker-inside.ts'), 'marker\n');
    await mkdir(join(dir, 'apps'));
    await symlink('../real', join(dir, 'apps/frontend'));
    expect([...(await readArtifacts(dir)).entries()]).toEqual([['apps/frontend/sdk', { kind: 'other' }]]);

    await rm(join(dir, 'apps'), { recursive: true });
    expect([...(await readArtifacts(dir)).entries()]).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test('SDK-006 diffArtifacts sorts by code unit, reports a changed entry kind, and never opens unpaired or resized files', async () => {
  const before = await scratch('foundation-sdk-006-before-');
  const after = await scratch('foundation-sdk-006-after-');
  try {
    for (const dir of [before, after]) await mkdir(join(dir, 'apps/frontend/sdk'), { recursive: true });
    const sdk = (dir: string, name: string) => join(dir, 'apps/frontend/sdk', name);

    // Code unit order: uppercase, then `_`, then lowercase, then non ASCII; localeCompare would mix them.
    for (const name of ['b.ts', 'Z.ts', '_x.ts', 'é.ts', 'A.ts']) await Bun.write(sdk(after, name), 'new\n');
    // Same bytes on both sides: not reported.
    await Bun.write(sdk(before, 'same.ts'), 'same\n');
    await Bun.write(sdk(after, 'same.ts'), 'same\n');
    // Same size, other bytes: changed.
    await Bun.write(sdk(before, 'bytes.ts'), 'aaaa\n');
    await Bun.write(sdk(after, 'bytes.ts'), 'bbbb\n');
    // A regular file before and a symlink after: changed, the link is not followed.
    await Bun.write(sdk(before, 'kind.ts'), 'file\n');
    await symlink('same.ts', sdk(after, 'kind.ts'));
    // A symlink on both sides has no bytes to compare, so the pair counts as changed.
    await symlink('same.ts', sdk(before, 'link.ts'));
    await symlink('same.ts', sdk(after, 'link.ts'));
    // Sparse 2 GiB files with mode 000 on the before side: opening them would fail, so they must never be opened.
    for (const name of ['huge-removed.bin', 'huge-resized.bin']) {
      await Bun.write(sdk(before, name), '');
      await truncate(sdk(before, name), 2 * 1024 ** 3);
      await chmod(sdk(before, name), 0o000);
    }
    await Bun.write(sdk(after, 'huge-resized.bin'), 'small\n');

    const diff = await diffArtifacts(before, after);
    expect(diff).toEqual({
      added: ['A.ts', 'Z.ts', '_x.ts', 'b.ts', 'é.ts'].map((name) => `apps/frontend/sdk/${name}`),
      changed: ['bytes.ts', 'huge-resized.bin', 'kind.ts', 'link.ts'].map((name) => `apps/frontend/sdk/${name}`),
      removed: ['apps/frontend/sdk/huge-removed.bin'],
    });
  } finally {
    await rm(before, { recursive: true, force: true });
    await rm(after, { recursive: true, force: true });
  }
}, 10_000);

test('SDK-006 formatDiffLines groups added, changed, removed in code unit order and escapes unusual names', () => {
  const diff: ArtifactDiff = {
    added: ['apps/frontend/sdk/b.ts', 'apps/frontend/sdk/A.ts'],
    changed: ['openapi.json', 'apps/frontend/sdk/with space.ts', 'apps/frontend/sdk/csi\u009b.ts'],
    removed: [
      'apps/frontend/sdk/rlo‮gnp.ts',
      'apps/frontend/sdk/café.ts',
      'apps/frontend/sdk/quote"back\\slash.ts',
      'apps/frontend/sdk/new\nline.ts',
      'apps/frontend/sdk/plain_name-1.2@x+y.ts',
    ],
  };
  expect(formatDiffLines(diff)).toEqual([
    'added apps/frontend/sdk/A.ts',
    'added apps/frontend/sdk/b.ts',
    'changed "apps/frontend/sdk/csi\\u009b.ts"',
    'changed "apps/frontend/sdk/with space.ts"',
    'changed openapi.json',
    'removed "apps/frontend/sdk/caf\\u00e9.ts"',
    'removed "apps/frontend/sdk/new\\u000aline.ts"',
    'removed apps/frontend/sdk/plain_name-1.2@x+y.ts',
    'removed "apps/frontend/sdk/quote\\"back\\\\slash.ts"',
    'removed "apps/frontend/sdk/rlo\\u202egnp.ts"',
  ]);
});

test('SDK-006 formatDiffLines prints at most 200 lines per kind, then one overflow line', () => {
  const names = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, index) => `apps/frontend/sdk/${prefix}${String(index).padStart(3, '0')}.ts`);
  const lines = formatDiffLines({ added: names(203, 'a'), changed: names(200, 'c'), removed: names(201, 'r') });
  expect(lines).toHaveLength(200 + 1 + 200 + 200 + 1);
  expect(lines[0]).toBe('added apps/frontend/sdk/a000.ts');
  expect(lines[199]).toBe('added apps/frontend/sdk/a199.ts');
  expect(lines[200]).toBe('... and 3 more added');
  expect(lines[201]).toBe('changed apps/frontend/sdk/c000.ts');
  expect(lines[400]).toBe('changed apps/frontend/sdk/c199.ts');
  expect(lines[401]).toBe('removed apps/frontend/sdk/r000.ts');
  expect(lines[601]).toBe('... and 1 more removed');
  expect(lines.filter((line) => line.startsWith('... and '))).toEqual(['... and 3 more added', '... and 1 more removed']);
});

// covers: AC-6 (*Format path* row): only `^[A-Za-z0-9._@+/-]+$` stays bare; every code unit outside 0x20..0x7E,
// including each half of a surrogate pair, becomes `\uXXXX`.
test('SDK-006 formatArtifactPath quotes printable names outside the plain set and escapes control, DEL, and surrogate code units', () => {
  const cases: Array<[path: string, formatted: string]> = [
    ['apps/frontend/sdk/models/development-status.ts', 'apps/frontend/sdk/models/development-status.ts'],
    ['apps/frontend/sdk/~tilde.ts', '"apps/frontend/sdk/~tilde.ts"'],
    ['apps/frontend/sdk/semi;colon.ts', '"apps/frontend/sdk/semi;colon.ts"'],
    ['apps/frontend/sdk/tab\there.ts', '"apps/frontend/sdk/tab\\u0009here.ts"'],
    ['apps/frontend/sdk/us\u001f.ts', '"apps/frontend/sdk/us\\u001f.ts"'],
    ['apps/frontend/sdk/del\u007f.ts', '"apps/frontend/sdk/del\\u007f.ts"'],
    ['apps/frontend/sdk/nbsp .ts', '"apps/frontend/sdk/nbsp\\u00a0.ts"'],
    ['apps/frontend/sdk/emoji\u{1f600}.ts', '"apps/frontend/sdk/emoji\\ud83d\\ude00.ts"'],
    ['apps/frontend/sdk/esc\u001b[31m.ts', '"apps/frontend/sdk/esc\\u001b[31m.ts"'],
  ];
  for (const [path, formatted] of cases) expect(formatArtifactPath(path), JSON.stringify(path)).toBe(formatted);
  // No formatted path can break a report line apart or carry a terminal escape.
  for (const [path] of cases) expect(/[\u0000-\u001f\u007f-￿]/.test(formatArtifactPath(path))).toBe(false);
});

test('SDK-006 formatDiffLines prints nothing for an empty diff and no overflow line at exactly 200 lines, and emptyDiff sees every kind', () => {
  expect(formatDiffLines({ added: [], changed: [], removed: [] })).toEqual([]);
  const exactly = Array.from({ length: 200 }, (_, index) => `apps/frontend/sdk/x${String(index).padStart(3, '0')}.ts`);
  const lines = formatDiffLines({ added: [], changed: [], removed: exactly });
  expect(lines).toHaveLength(200);
  expect(lines.some((line) => line.startsWith('... and '))).toBe(false);

  expect(emptyDiff({ added: [], changed: [], removed: [] })).toBe(true);
  expect(emptyDiff({ added: ['openapi.json'], changed: [], removed: [] })).toBe(false);
  expect(emptyDiff({ added: [], changed: ['openapi.json'], removed: [] })).toBe(false);
  expect(emptyDiff({ added: [], changed: [], removed: ['openapi.json'] })).toBe(false);
});

// covers: AC-6 (*Artefak tersimpan* row): openapi.json and every path segment up to apps/frontend/sdk are read with
// lstat; anything that is not a regular file or a real directory is one `other` entry and is never followed.
test('SDK-006 readArtifacts reports a non regular openapi.json and an SDK path blocked by a file or a symlinked apps folder as other entries', async () => {
  const dir = await scratch('foundation-sdk-006-kinds-');
  try {
    // openapi.json as a symlink to a real file, beside an SDK folder holding one file.
    await Bun.write(join(dir, 'contract-target.json'), '{"marker":true}\n');
    await symlink('contract-target.json', join(dir, 'openapi.json'));
    await Bun.write(join(dir, 'apps/frontend/sdk/api.ts'), 'export {};\n');
    expect([...(await readArtifacts(dir)).entries()]).toEqual([
      ['openapi.json', { kind: 'other' }],
      ['apps/frontend/sdk/api.ts', { kind: 'file', size: 11 }],
    ]);

    // openapi.json as a directory is one other entry, and what it holds is not read.
    await rm(join(dir, 'openapi.json'));
    await Bun.write(join(dir, 'openapi.json/inner.json'), '{}\n');
    expect((await readArtifacts(dir)).get('openapi.json')).toEqual({ kind: 'other' });
    expect([...(await readArtifacts(dir)).keys()].some((path) => path.startsWith('openapi.json/'))).toBe(false);

    // apps/frontend/sdk as a regular file.
    await rm(join(dir, 'apps'), { recursive: true });
    await Bun.write(join(dir, 'apps/frontend/sdk'), 'not a folder\n');
    expect((await readArtifacts(dir)).get('apps/frontend/sdk')).toEqual({ kind: 'other' });

    // apps itself as a symlink to a tree that holds a full SDK folder.
    await rm(join(dir, 'apps'), { recursive: true });
    await Bun.write(join(dir, 'elsewhere/frontend/sdk/marker-inside.ts'), 'marker\n');
    await symlink('elsewhere', join(dir, 'apps'));
    const entries = await readArtifacts(dir);
    expect(entries.get('apps/frontend/sdk')).toEqual({ kind: 'other' });
    expect([...entries.keys()].filter((path) => path.startsWith('apps/'))).toEqual(['apps/frontend/sdk']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

// ---------------------------------------------------------------------------------------------------------------
// SDK-006 and SDK-007 (AC-6, AC-7): api:check runs against isolated workspaces.

test('SDK-006 SDK-007 api:check passes a checkout that matches two runs and leaves the checkout and TMPDIR untouched', async () => {
  const dir = await workspace();
  const temporary = await scratch('foundation-sdk-check-tmp-');
  try {
    const before = await checkoutSnapshot(dir);
    const result = await run(dir, 'api:check', { timeout: checkTimeoutMs, env: { TMPDIR: temporary } });
    expect(result.code, result.output).toBe(0);
    expect(outputLines(result.stdout)).toContain('OpenAPI and SDK match stored artifacts across two runs');
    expect(reportLines(result.stderr)).toEqual([]);
    expect(result.output).not.toContain('drift detected');
    expect(result.output).not.toContain('not repeatable');
    expect(await checkoutSnapshot(dir)).toBe(before);
    expect(await readdir(temporary)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}, heavyTestTimeoutMs);

test('SDK-006 api:check names every drifted artifact in one run without printing file contents', async () => {
  const dir = await workspace();
  const temporary = await scratch('foundation-sdk-check-tmp-');
  const secret = marker('SDK006CONTENT');
  try {
    const sdk = join(dir, 'apps/frontend/sdk');
    // Changed SDK file, with a synthetic marker that must never reach the output.
    await Bun.write(join(sdk, 'api.ts'), `${await Bun.file(join(sdk, 'api.ts')).text()}// ${secret}\n`);
    // Deleted SDK file.
    await rm(join(sdk, 'models/development-status.ts'));
    // File without an owner.
    await Bun.write(join(sdk, 'unowned-extra.ts'), `// ${secret}\n`);
    // Stale manifest entry together with its file.
    const manifestPath = join(sdk, '.ojiepermana-sdk-manifest.json');
    const manifest = await Bun.file(manifestPath).json();
    manifest.files.push('obsolete.ts');
    await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await Bun.write(join(sdk, 'obsolete.ts'), `// ${secret}\n`);
    // Symlink inside the SDK folder, pointing at a file whose content must not be read.
    await Bun.write(join(dir, 'symlink-target.txt'), `${secret}\n`);
    await symlink('../../../symlink-target.txt', join(sdk, 'linked.ts'));
    // Missing openapi.json.
    await rm(join(dir, 'openapi.json'));

    const before = await checkoutSnapshot(dir);
    const result = await run(dir, 'api:check', { timeout: checkTimeoutMs, env: { TMPDIR: temporary } });
    expect(result.code, result.output).toBe(1);
    expectReport(
      result.stderr,
      [
        'added apps/frontend/sdk/models/development-status.ts',
        'added openapi.json',
        'changed apps/frontend/sdk/.ojiepermana-sdk-manifest.json',
        'changed apps/frontend/sdk/api.ts',
        'removed apps/frontend/sdk/linked.ts',
        'removed apps/frontend/sdk/obsolete.ts',
        'removed apps/frontend/sdk/unowned-extra.ts',
      ],
      'OpenAPI or SDK drift detected',
    );
    expect(result.stdout).not.toContain('OpenAPI and SDK match');
    expect(result.output).not.toContain(secret);
    expect(await checkoutSnapshot(dir)).toBe(before);
    expect(await readdir(temporary)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}, heavyTestTimeoutMs);

test('SDK-006 api:check reports a status route change made without api:sync as changed artifacts', async () => {
  const dir = await workspace();
  const temporary = await scratch('foundation-sdk-check-tmp-');
  const summary = marker('SDK006ROUTE');
  try {
    const route = join(dir, 'apps/backend/src/features/development/status.routes.ts');
    const source = await Bun.file(route).text();
    expect(source).toContain("summary: 'Development process status'");
    await Bun.write(route, source.replace("summary: 'Development process status'", `summary: 'Development process status ${summary}'`));

    const before = await checkoutSnapshot(dir);
    const result = await run(dir, 'api:check', { timeout: checkTimeoutMs, env: { TMPDIR: temporary } });
    expect(result.code, result.output).toBe(1);
    expectReport(
      result.stderr,
      ['changed apps/frontend/sdk/services/development.service.ts', 'changed openapi.json'],
      'OpenAPI or SDK drift detected',
    );
    expect(result.output).not.toContain(summary);
    expect(await checkoutSnapshot(dir)).toBe(before);
    expect(await readdir(temporary)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}, heavyTestTimeoutMs);

// covers: key invariant 1 and the `API check failed` failure: when the temporary directory cannot be removed, a check
// whose two runs matched the checkout still ends with exit 1 and `API check failed`, never with a silent pass.
// A folder without write permission stops `rm` only for a user other than root, so the test is skipped, and reported
// as skipped, when it runs as root (for example in a Docker container).
test.skipIf(process.getuid?.() === 0)('SDK-006 api:check ends with API check failed and exit 1 when its temporary directory cannot be removed', async () => {
  const dir = await workspace();
  const temporary = await scratch('foundation-sdk-check-tmp-');
  try {
    // sdk:generate runs in apps/frontend; it also leaves a folder without write permission in the workspace, outside
    // the compared artifacts, so `rm` of the temporary directory fails after both runs.
    const packagePath = join(dir, 'package.json');
    const manifest = await Bun.file(packagePath).json();
    manifest.scripts['sdk:generate'] = `${manifest.scripts['sdk:generate']} && mkdir -p ../../locked/inner && chmod 555 ../../locked`;
    await Bun.write(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
    const before = await checkoutSnapshot(dir);
    const result = await run(dir, 'api:check', { timeout: checkTimeoutMs, env: { TMPDIR: temporary } });
    expect(result.code, result.output).toBe(1);
    expect(outputLines(result.stdout)).toContain('OpenAPI and SDK match stored artifacts across two runs');
    expect(outputLines(result.stderr)).toContain('API check failed');
    expect(reportLines(result.stderr)).toEqual([]);
    expect(await checkoutSnapshot(dir)).toBe(before);
    // The run directory is the one left behind, because it could not be removed.
    expect((await readdir(temporary)).map((name) => name.replace(/[^-]+$/, ''))).toEqual(['foundation-api-check-']);
  } finally {
    await Bun.spawn(['chmod', '-R', 'u+w', temporary], { stdout: 'ignore', stderr: 'ignore' }).exited;
    await rm(dir, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}, heavyTestTimeoutMs);

test('SDK-007 api:check compares the two runs first and stops at a generator that is not repeatable', async () => {
  const dir = await workspace();
  const temporary = await scratch('foundation-sdk-check-tmp-');
  try {
    // The probe sits under scripts/, an API input, so the isolated workspace of api:check holds it too.
    await Bun.write(
      join(dir, 'scripts/sdk-time-probe.ts'),
      "import { appendFileSync } from 'node:fs';\nappendFileSync('sdk/api.ts', `// ${Date.now()}\\n`);\n",
    );
    const packagePath = join(dir, 'package.json');
    const manifest = await Bun.file(packagePath).json();
    manifest.scripts['sdk:generate'] = `${manifest.scripts['sdk:generate']} && bun --no-env-file ../../scripts/sdk-time-probe.ts`;
    await Bun.write(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);

    const before = await checkoutSnapshot(dir);
    const result = await run(dir, 'api:check', { timeout: checkTimeoutMs, env: { TMPDIR: temporary } });
    expect(result.code, result.output).toBe(1);
    expectReport(result.stderr, ['changed apps/frontend/sdk/api.ts'], 'OpenAPI or SDK generation is not repeatable');
    expect(result.output).not.toContain('OpenAPI or SDK drift detected');
    expect(result.stdout).not.toContain('OpenAPI and SDK match');
    expect(await checkoutSnapshot(dir)).toBe(before);
    expect(await readdir(temporary)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}, heavyTestTimeoutMs);

// ---------------------------------------------------------------------------------------------------------------
// SDK-010 (AC-10): process groups, signals, and the per run time limit.

test('SDK-010 runProcessGroup stops a group that ignores SIGTERM with SIGKILL after the grace period', async () => {
  const dir = await scratch('foundation-sdk-010-unit-');
  try {
    const started = performance.now();
    const result = await runProcessGroup(['sh', '-c', "trap '' TERM; sleep 600 >/dev/null 2>&1 & echo $!; wait"], {
      cwd: dir,
      env: { PATH: process.env['PATH']! },
      timeoutMs: 300,
      output: 'pipe',
    });
    const elapsed = performance.now() - started;
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.code).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(5_000);
    const grandchild = Number(result.stdout.trim());
    expect(grandchild).toBeGreaterThan(1);
    expect(processDead(grandchild)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test('SDK-010 runProcessGroup kills members left behind after the leader exits on its own', async () => {
  const dir = await scratch('foundation-sdk-010-unit-');
  try {
    const result = await runProcessGroup(['sh', '-c', 'sleep 600 >/dev/null 2>&1 & echo $!'], {
      cwd: dir,
      env: { PATH: process.env['PATH']! },
      timeoutMs: 10_000,
      output: 'pipe',
    });
    expect(result).toMatchObject({ code: 0, timedOut: false, aborted: false });
    const grandchild = Number(result.stdout.trim());
    expect(grandchild).toBeGreaterThan(1);
    expect(processDead(grandchild)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test('SDK-010 runProcessGroup stops the whole group when its AbortSignal fires', async () => {
  const dir = await scratch('foundation-sdk-010-unit-');
  const controller = new AbortController();
  try {
    const pidFile = join(dir, 'grandchild.pid');
    const running = runProcessGroup(['sh', '-c', `sleep 600 >/dev/null 2>&1 & echo $! > '${pidFile}'; wait`], {
      cwd: dir,
      env: { PATH: process.env['PATH']! },
      timeoutMs: 60_000,
      output: 'pipe',
      signal: controller.signal,
    });
    const grandchild = await waitForPid(pidFile, 10_000);
    controller.abort();
    expect(await running).toMatchObject({ timedOut: false, aborted: true });
    expect(processDead(grandchild)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

// covers: AC-10 (*Grup proses* row): a group that obeys SIGTERM ends within the grace period, without SIGKILL.
test('SDK-010 runProcessGroup ends a group that obeys SIGTERM on timeout without waiting for the SIGKILL grace period', async () => {
  const dir = await scratch('foundation-sdk-010-unit-');
  try {
    const pidFile = join(dir, 'grandchild.pid');
    const started = performance.now();
    const result = await runProcessGroup(['sh', '-c', `sleep 600 >/dev/null 2>&1 & echo $! > '${pidFile}'; wait`], {
      cwd: dir,
      env: { PATH: process.env['PATH']! },
      timeoutMs: 300,
      output: 'pipe',
    });
    const elapsed = performance.now() - started;
    expect(result).toMatchObject({ code: null, timedOut: true, aborted: false });
    expect(elapsed).toBeLessThan(5_000);
    expect(processDead(await waitForPid(pidFile, 1_000))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

// covers: AC-6 and AC-10 (*Grup proses* row): `env` is the complete child environment, output is collected per
// stream, and the leader's exit code is returned as is.
test('SDK-010 runProcessGroup passes exactly the given environment, keeps stdout and stderr apart, and returns the exit code', async () => {
  const dir = await scratch('foundation-sdk-010-unit-');
  const previous = process.env['FOUNDATION_PARENT_ONLY'];
  process.env['FOUNDATION_PARENT_ONLY'] = marker('parent-only-');
  try {
    const listed = await runProcessGroup(['/usr/bin/env'], {
      cwd: dir,
      env: { PATH: '/usr/bin:/bin', ONLY_THIS: 'value with spaces' },
      timeoutMs: 10_000,
      output: 'pipe',
    });
    expect(listed).toMatchObject({ code: 0, timedOut: false, aborted: false, stderr: '' });
    expect(outputLines(listed.stdout).sort()).toEqual(['ONLY_THIS=value with spaces', 'PATH=/usr/bin:/bin']);

    const failed = await runProcessGroup(['sh', '-c', 'echo to-stdout; echo to-stderr >&2; exit 3'], {
      cwd: dir,
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 10_000,
      output: 'pipe',
    });
    expect(failed).toEqual({ code: 3, timedOut: false, aborted: false, stdout: 'to-stdout\n', stderr: 'to-stderr\n' });
  } finally {
    if (previous === undefined) delete process.env['FOUNDATION_PARENT_ONLY'];
    else process.env['FOUNDATION_PARENT_ONLY'] = previous;
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test('SDK-010 runProcessGroup rejects an empty or missing command and never starts a command whose signal already aborted', async () => {
  const dir = await scratch('foundation-sdk-010-unit-');
  try {
    const options = { cwd: dir, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 10_000, output: 'pipe' } as const;
    const empty = await runProcessGroup([], options).then(() => undefined, (error: unknown) => error);
    expect((empty as Error).message).toBe('Empty command');

    const missing = await runProcessGroup(['foundation-sdk-010-missing-command'], options).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(missing).toBeInstanceOf(Error);
    expect((missing as NodeJS.ErrnoException).code).toBe('ENOENT');

    const controller = new AbortController();
    controller.abort();
    const sentinel = join(dir, 'started');
    const skipped = await runProcessGroup(['sh', '-c', `touch '${sentinel}'`], { ...options, signal: controller.signal });
    expect(skipped).toEqual({ code: null, timedOut: false, aborted: true, stdout: '', stderr: '' });
    expect(await Bun.file(sentinel).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

// covers: review finding, an abort between spawn() and the `spawn` event fired before the listener existed, so the
// group ran to its end. In api:check that was a SIGINT or SIGTERM landing just before a stage (AC-10, invariant 1).
test('SDK-010 runProcessGroup stops the group when its AbortSignal fires while the child is still spawning', async () => {
  const dir = await scratch('foundation-sdk-010-unit-');
  const controller = new AbortController();
  try {
    const started = performance.now();
    const running = runProcessGroup(['sh', '-c', 'sleep 20'], {
      cwd: dir,
      env: { PATH: process.env['PATH']! },
      timeoutMs: 60_000,
      output: 'pipe',
      signal: controller.signal,
    });
    controller.abort();
    expect(await running).toMatchObject({ code: null, timedOut: false, aborted: true });
    expect(performance.now() - started).toBeLessThan(5_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

// covers: review finding, the 5 second timer of the stream wait in pipe mode was never cleared and held the calling
// process open after the group ended.
test('SDK-010 runProcessGroup with piped output lets its process exit at once after the group ends', async () => {
  const probe = [
    `import { runProcessGroup } from ${JSON.stringify(join(root, 'scripts/lib/process-group.ts'))};`,
    "const result = await runProcessGroup(['sh', '-c', 'echo ready'], { cwd: process.cwd(), env: { PATH: '/usr/bin:/bin' }, timeoutMs: 10_000, output: 'pipe' });",
    'process.stdout.write(`${result.stdout.trim()} ${Date.now()}\\n`);',
  ].join('\n');
  const child = start([process.execPath, '--no-env-file', '-e', probe], root, { PATH: process.env['PATH']!, HOME: process.env['HOME']! });
  const result = await child.finished;
  const closed = Date.now();
  expect(result.code, result.stderr).toBe(0);
  const returned = Number(result.stdout.match(/^ready (\d+)$/m)?.[1]);
  expect(returned).toBeGreaterThan(0);
  expect(closed - returned).toBeLessThan(2_000);
}, 30_000);

// covers: AC-10 and the *Grup proses* failure column ("Group masih hidup 5 detik sesudah SIGKILL: melempar error").
// A stand in `ps` first on the probe's PATH reports the group as alive forever, the one way to see a group survive
// SIGKILL; the real leader is killed and checked with the real `ps` afterwards.
test('SDK-010 runProcessGroup rejects with Process group did not stop when the group still looks alive 5 seconds after SIGKILL', async () => {
  const dir = await scratch('foundation-sdk-010-unit-');
  try {
    const bin = join(dir, 'bin');
    const pidFile = join(dir, 'leader.pid');
    await mkdir(bin);
    await Bun.write(join(bin, 'ps'), `#!/bin/sh\nprintf '%s S\\n' "$(cat '${pidFile}' 2>/dev/null)"\n`);
    await chmod(join(bin, 'ps'), 0o755);
    const leader = `echo $$ > '${pidFile}'; exec sleep 600`;
    const probe = [
      `import { runProcessGroup } from ${JSON.stringify(join(root, 'scripts/lib/process-group.ts'))};`,
      'const started = performance.now();',
      `const outcome = await runProcessGroup(['sh', '-c', ${JSON.stringify(leader)}], { cwd: process.cwd(), env: { PATH: '/usr/bin:/bin' }, timeoutMs: 200, output: 'pipe' })`,
      '  .then(() => "resolved", (error) => error.message);',
      'process.stdout.write(`${outcome}|${Math.round(performance.now() - started)}\\n`);',
    ].join('\n');
    const result = await runProcessGroup([process.execPath, '--no-env-file', '-e', probe], {
      cwd: dir,
      env: { PATH: `${bin}:${process.env['PATH']!}`, HOME: process.env['HOME']! },
      timeoutMs: 60_000,
      output: 'pipe',
    });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const [outcome, elapsed] = result.stdout.trim().split('|');
    expect(outcome).toBe('Process group did not stop');
    // SIGTERM grace, then SIGKILL grace: about 200 + 5000 + 5000 ms.
    expect(Number(elapsed)).toBeGreaterThanOrEqual(10_000);
    expect(processDead(await waitForPid(pidFile, 1_000))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 40_000);

/** Polls until `path` holds a pid, at most `timeoutMs`. */
async function waitForPid(path: string, timeoutMs: number): Promise<number> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const file = Bun.file(path);
    if (await file.exists()) {
      const pid = Number((await file.text()).trim());
      if (Number.isInteger(pid) && pid > 1) return pid;
    }
    await Bun.sleep(50);
  }
  throw new Error('No pid file');
}

/** A workspace whose `sdk:generate` starts a grandchild, writes its pid to `$HOME/sdk-grandchild.pid`, and waits. */
async function hangingWorkspace(): Promise<string> {
  const dir = await workspace();
  await Bun.write(
    join(dir, 'scripts/sdk-grandchild-probe.ts'),
    [
      "const grandchild = Bun.spawn(['sleep', '600'], { stdio: ['ignore', 'ignore', 'ignore'] });",
      "await Bun.write(`${process.env['HOME']}/sdk-grandchild.pid`, String(grandchild.pid));",
      'await grandchild.exited;',
      '',
    ].join('\n'),
  );
  const packagePath = join(dir, 'package.json');
  const manifest = await Bun.file(packagePath).json();
  manifest.scripts['sdk:generate'] = 'bun --no-env-file scripts/sdk-grandchild-probe.ts';
  await Bun.write(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

type Finished = { code: number | null; stdout: string; stderr: string };

/** Starts `argv` in `cwd` with exactly `env`, returning its pid and a promise of how it ended. */
function start(argv: string[], cwd: string, env: Record<string, string>): { pid: number; finished: Promise<Finished> } {
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const finished = new Promise<Finished>((resolve) =>
    child.once('close', (code) =>
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }),
    ),
  );
  return { pid: child.pid!, finished };
}

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
  test(`SDK-010 api:check stops the running api:sync group on ${signal}, exits ${code}, and leaves nothing behind`, async () => {
    const dir = await hangingWorkspace();
    const home = await scratch('foundation-sdk-010-home-');
    const temporary = await scratch('foundation-sdk-010-tmp-');
    let checker: ReturnType<typeof start> | undefined;
    try {
      const before = await checkoutSnapshot(dir);
      checker = start([process.execPath, '--no-env-file', 'scripts/check-api.ts'], dir, {
        PATH: process.env['PATH']!,
        HOME: home,
        TMPDIR: temporary,
      });
      const grandchild = await waitForPid(join(home, 'sdk-grandchild.pid'), 60_000);
      expect(processDead(grandchild)).toBe(false);
      // The run directory lives under the TMPDIR given to api:check, so the empty TMPDIR afterwards means it was removed.
      expect((await readdir(temporary)).map((name) => name.replace(/[^-]+$/, ''))).toEqual(['foundation-api-check-']);
      process.kill(checker.pid, signal);
      const result = await checker.finished;
      expect(result.code, result.stdout + result.stderr).toBe(code);
      expect(reportLines(result.stderr)).toEqual([]);
      expect(result.stdout + result.stderr).not.toContain('API synchronization failed');
      expect(processDead(grandchild)).toBe(true);
      expect(await readdir(temporary)).toEqual([]);
      expect(await checkoutSnapshot(dir)).toBe(before);
    } finally {
      if (checker && !processDead(checker.pid)) process.kill(checker.pid, 'SIGKILL');
      await rm(dir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
      await rm(temporary, { recursive: true, force: true });
    }
  }, heavyTestTimeoutMs);
}

test('SDK-010 runApiCheck stops an api:sync run that passes syncTimeoutMs and reports API synchronization failed', async () => {
  const dir = await hangingWorkspace();
  const home = await scratch('foundation-sdk-010-home-');
  const temporary = await scratch('foundation-sdk-010-tmp-');
  try {
    const before = await checkoutSnapshot(dir);
    const probe = [
      `import { runApiCheck } from ${JSON.stringify(join(dir, 'scripts/lib/api-check.ts'))};`,
      'process.exitCode = await runApiCheck({ root: process.cwd(), syncTimeoutMs: 2_000 });',
    ].join('\n');
    const result = await runProcessGroup([process.execPath, '--no-env-file', '-e', probe], {
      cwd: dir,
      env: { PATH: process.env['PATH']!, HOME: home, TMPDIR: temporary },
      timeoutMs: 60_000,
      output: 'pipe',
    });
    expect(result.timedOut).toBe(false);
    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect(outputLines(result.stderr)).toContain('API synchronization failed');
    expect(reportLines(result.stderr)).toEqual([]);
    const grandchild = await waitForPid(join(home, 'sdk-grandchild.pid'), 1_000);
    expect(processDead(grandchild)).toBe(true);
    expect(await readdir(temporary)).toEqual([]);
    expect(await checkoutSnapshot(dir)).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}, heavyTestTimeoutMs);

// ---------------------------------------------------------------------------------------------------------------
// SDK-004 (AC-4), workspace part: `ng test` in an isolated workspace with a sentinel `.env` and sentinel environment.

test('SDK-004 ng test in an isolated workspace starts one backend that never sees the root .env or parent secrets', async () => {
  const dir = await workspace();
  const sentinel = marker('sdk-004-secret-');
  try {
    await copyFrontendApplication(dir);
    await Bun.write(join(dir, '.env'), 'DATABASE_URL=not-a-url\n');
    const result = await runProcessGroup(
      [
        'node',
        '../../node_modules/@angular/cli/bin/ng.js',
        'test',
        '--watch=false',
        '--include',
        'src/app/sdk-contract.integration.spec.ts',
        '--reporters=default',
      ],
      {
        cwd: join(dir, 'apps/frontend'),
        env: { PATH: process.env['PATH']!, HOME: process.env['HOME']!, DATABASE_URL: 'not-a-url', FOUNDATION_TEST_SECRET: sentinel },
        timeoutMs: checkTimeoutMs,
        output: 'pipe',
      },
    );
    const output = result.stdout + result.stderr;
    expect(result.timedOut).toBe(false);
    expect(result.code, output).toBe(0);
    const lines = outputLines(output);
    const listening = lines.filter((line) => line.startsWith('SDK contract backend listening on '));
    expect(listening).toHaveLength(1);
    const match = listening[0]!.match(/^SDK contract backend listening on 127\.0\.0\.1:(\d+)$/);
    expect(match).not.toBeNull();
    expect(lines.filter((line) => line === 'SDK contract backend stopped')).toHaveLength(1);
    expect(lines.indexOf('SDK contract backend stopped')).toBeGreaterThan(lines.indexOf(listening[0]!));
    const afterRun = await fetch(`http://127.0.0.1:${match![1]}/api/status`).then(
      () => 'answered',
      () => 'refused',
    );
    expect(afterRun).toBe('refused');
    expect(output).not.toContain(sentinel);
    expect(output).not.toContain('not-a-url');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, heavyTestTimeoutMs);

// ---------------------------------------------------------------------------------------------------------------
// SDK-001 (AC-1): the stages and the locale pin of api:sync, and what one api:sync writes.

const noDifference: ArtifactDiff = { added: [], changed: [], removed: [] };
const sdkGenerateScript =
  'cd apps/frontend && LC_ALL=en_US.UTF-8 node ../../node_modules/@angular/cli/bin/ng.js generate @ojiepermana/angular:sdk --config sdk.config.json';

test('SDK-001 api:sync runs the three stages in order and sdk:generate pins LC_ALL=en_US.UTF-8 from apps/frontend', async () => {
  const { scripts } = await Bun.file(join(root, 'package.json')).json();
  expect(scripts['api:sync']).toBe('bun run api:openapi && bun run api:validate && bun run sdk:generate');
  expect(scripts['sdk:generate']).toBe(sdkGenerateScript);
});

/** The `syncTimeoutMs` value `scripts/check-api.ts` passes to its one `runApiCheck` call, read from the source. */
async function cliSyncTimeoutMs(): Promise<number | undefined> {
  const path = join(root, 'scripts/check-api.ts');
  const file = ts.createSourceFile(path, await Bun.file(path).text(), ts.ScriptTarget.Latest, true);
  const constants = new Map<string, ts.Expression>();
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) {
      constants.set(node.name.text, node.initializer);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'runApiCheck') calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (calls.length !== 1) return undefined;
  const [options] = calls[0]!.arguments;
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
  const property = options.properties.find((item) => item.name !== undefined && ts.isIdentifier(item.name) && item.name.text === 'syncTimeoutMs');
  let value: ts.Expression | undefined;
  if (property && ts.isShorthandPropertyAssignment(property)) value = constants.get(property.name.text);
  else if (property && ts.isPropertyAssignment(property)) {
    value = ts.isIdentifier(property.initializer) ? constants.get(property.initializer.text) : property.initializer;
  }
  return value && ts.isNumericLiteral(value) ? Number(value.text.replaceAll('_', '')) : undefined;
}

// covers: AC-6 and AC-10 ("bun run api:check menjalankan bun --no-env-file scripts/check-api.ts, yang memanggil
// runApiCheck dengan batas 120.000 ms per api:sync"). The other api:check tests pass their own limit or end long
// before any limit, so only this test pins the CLI.
test('SDK-006 SDK-010 api:check runs bun --no-env-file scripts/check-api.ts, which gives runApiCheck a 120000 ms limit per api:sync', async () => {
  const { scripts } = await Bun.file(join(root, 'package.json')).json();
  expect(scripts['api:check']).toBe('bun --no-env-file scripts/check-api.ts');
  expect(await cliSyncTimeoutMs()).toBe(120_000);
});

/** True for a `checkoutSnapshot` line about `openapi.json` or about an entry at or below `apps/frontend/sdk`. */
function artifactLine(line: string): boolean {
  return /^\S+ (openapi\.json|apps\/frontend\/sdk)( |\/|$)/.test(line);
}

test('SDK-001 one api:sync in a workspace holding only API_INPUTS reproduces the stored artifacts and writes nothing else', async () => {
  const dir = await workspace({ artifacts: false });
  try {
    const inputs = new Set(API_INPUTS.map((input) => input.split('/')[0]!));
    for (const name of await readdir(dir)) if (name !== 'node_modules') expect(inputs.has(name)).toBe(true);
    expect([...(await readArtifacts(dir)).keys()]).toEqual([]);
    const before = (await checkoutSnapshot(dir)).split('\n');
    expect(before.filter(artifactLine)).toEqual([]);

    const result = await run(dir, 'api:sync', { timeout: checkTimeoutMs });
    expect(result.code, result.output).toBe(0);
    expect(await diffArtifacts(root, dir)).toEqual(noDifference);
    const after = (await checkoutSnapshot(dir)).split('\n');
    expect(after.filter((line) => !artifactLine(line))).toEqual(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, heavyTestTimeoutMs);

// ---------------------------------------------------------------------------------------------------------------
// SDK-002 (AC-2): the application SDK configuration, and the SDK inside the Angular build.

/** A tsconfig style file, which may hold comments. */
async function readConfigWithComments(path: string): Promise<Record<string, any>> {
  const parsed = ts.parseConfigFileTextToJson(path, await Bun.file(path).text());
  if (parsed.error) throw new Error(`Cannot parse ${path}`);
  return parsed.config;
}

test('SDK-002 sdk.config.json, the tsconfig files, and app.config.ts hold the values of AC-2', async () => {
  const frontend = join(root, 'apps/frontend');
  const config = await Bun.file(join(frontend, 'sdk.config.json')).json();
  expect(config.targets).toHaveLength(1);
  expect(config.targets[0]).toMatchObject({
    input: '../../openapi.json',
    output: './sdk',
    mode: 'standalone',
    clientName: 'FoundationApi',
    rootUrl: '',
    splitByDomain: false,
    features: { models: true, operations: true, services: true, client: true, metadata: false, navigation: false, resources: false },
  });
  expect((await readConfigWithComments(join(frontend, 'tsconfig.app.json')))['include']).toContain('sdk/**/*.ts');
  expect((await readConfigWithComments(join(frontend, 'tsconfig.json')))['compilerOptions'].paths['@sdk']).toEqual(['./sdk/public-api.ts']);

  const appConfig = await Bun.file(join(frontend, 'src/app/app.config.ts')).text();
  expect(appConfig).toMatch(/^import \{[^}]*\bprovideHttpClient\b[^}]*\} from '@angular\/common\/http';$/m);
  expect(appConfig).toMatch(/^import \{[^}]*\bprovideApiConfiguration\b[^}]*\} from '@sdk';$/m);
  const providers = appConfig.slice(appConfig.indexOf('providers: ['));
  expect(providers).toContain('provideHttpClient(),');
  expect(providers).toContain("provideApiConfiguration(''),");
});

/** `package.json`, `openapi.json`, and `apps/frontend` without `dist`, `.angular`, or `.env` files, with `node_modules` linked. */
async function frontendWorkspace(): Promise<string> {
  const dir = await scratch('foundation-sdk-002-');
  await cp(join(root, 'package.json'), join(dir, 'package.json'));
  await cp(join(root, 'openapi.json'), join(dir, 'openapi.json'));
  await copyFrontendApplication(dir);
  await symlink(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

/** `ng build` from `frontend` with only PATH and HOME, as its own process group. */
async function ngBuild(frontend: string): Promise<{ code: number | null; output: string }> {
  const result = await runProcessGroup(['node', '../../node_modules/@angular/cli/bin/ng.js', 'build'], {
    cwd: frontend,
    env: { PATH: process.env['PATH']!, HOME: process.env['HOME']! },
    timeoutMs: checkTimeoutMs,
    output: 'pipe',
  });
  expect(result.timedOut).toBe(false);
  return { code: result.code, output: result.stdout + result.stderr };
}

test('SDK-002 ng build compiles the SDK: production JavaScript holds rootUrl, and a type error in an SDK model fails the build', async () => {
  const dir = await frontendWorkspace();
  const frontend = join(dir, 'apps/frontend');
  try {
    const clean = await ngBuild(frontend);
    expect(clean.code, clean.output).toBe(0);
    const scripts = (await readdir(join(frontend, 'dist'), { recursive: true }))
      .filter((name) => name.endsWith('.js'))
      .map((name) => join(frontend, 'dist', name));
    expect(scripts.length).toBeGreaterThan(0);
    const withRootUrl: string[] = [];
    for (const file of scripts) if ((await Bun.file(file).text()).includes('rootUrl')) withRootUrl.push(file);
    expect(withRootUrl.length).toBeGreaterThan(0);

    const model = join(frontend, 'sdk/models/development-status.ts');
    const source = await Bun.file(model).text();
    await Bun.write(model, `${source.endsWith('\n') ? source : `${source}\n`}export const sdkBuildProbe: number = 'x';\n`);
    await rm(join(frontend, 'dist'), { recursive: true, force: true });
    await rm(join(frontend, '.angular'), { recursive: true, force: true });
    const broken = await ngBuild(frontend);
    expect(typeof broken.code).toBe('number');
    expect(broken.code, broken.output).not.toBe(0);
    expect(broken.output).toContain('TS2322');
    expect(broken.output).toContain('sdk/models/development-status.ts');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, heavyTestTimeoutMs);

// ---------------------------------------------------------------------------------------------------------------
// SDK-005 (AC-5): the generator manifest, files without an owner, and a conflict with one.

const probeRoute = `import { Elysia, t } from 'elysia';

// Test route of SDK-005 on the new tag probe, with named models on status 200 and 503.
export const probeRoutes = new Elysia({ name: 'probe' })
  .model('ProbeAvailable', t.Object({ status: t.Literal('available', { enum: ['available'] }) }, { additionalProperties: false }))
  .model('ProbeUnavailable', t.Object({ status: t.Literal('unavailable', { enum: ['unavailable'] }) }, { additionalProperties: false }))
  .get('/api/probe', () => ({ status: 'available' as const }), {
    response: { 200: 'ProbeAvailable', 503: 'ProbeUnavailable' },
    detail: { operationId: 'getProbe', tags: ['probe'], security: [], summary: 'Probe route of SDK-005' },
  });
`;

/** Replacements in `apps/backend/src/app.ts` that add the probe route and its tag to the development composition. */
const probeComposition: ReadonlyArray<readonly [string, string]> = [
  [
    "import { developmentRoutes } from './features/development/status.routes';",
    "import { developmentRoutes } from './features/development/status.routes';\nimport { probeRoutes } from './features/probe/probe.routes';",
  ],
  ["tags: [{ name: 'development' }]", "tags: [{ name: 'development' }, { name: 'probe' }]"],
  ['.use(developmentRoutes);', '.use(developmentRoutes).use(probeRoutes);'],
];

const probeFiles = ['fn/probe/get-probe.ts', 'models/probe-available.ts', 'models/probe-unavailable.ts', 'services/probe.service.ts'].map(
  (name) => `apps/frontend/sdk/${name}`,
);

async function addProbeRoute(dir: string): Promise<void> {
  await Bun.write(join(dir, 'apps/backend/src/features/probe/probe.routes.ts'), probeRoute);
  const app = join(dir, 'apps/backend/src/app.ts');
  let text = await Bun.file(app).text();
  for (const [from, to] of probeComposition) {
    if (!text.includes(from)) throw new Error('Test setup text not found in apps/backend/src/app.ts');
    text = text.replace(from, to);
  }
  await Bun.write(app, text);
}

async function removeProbeRoute(dir: string): Promise<void> {
  await cp(join(root, 'apps/backend/src/app.ts'), join(dir, 'apps/backend/src/app.ts'));
  await rm(join(dir, 'apps/backend/src/features/probe'), { recursive: true });
}

test('SDK-005 api:sync lists the files of a new tag in the manifest, deletes them with the route, and keeps a file without an owner', async () => {
  const dir = await workspace();
  const temporary = await scratch('foundation-sdk-check-tmp-');
  const sdk = join(dir, 'apps/frontend/sdk');
  try {
    await addProbeRoute(dir);
    const added = await run(dir, 'api:sync', { timeout: checkTimeoutMs });
    expect(added.code, added.output).toBe(0);
    expect(outputLines(added.output)).toContain('OpenAPI project checks passed');

    // Named models on 200 and 503 (adapter contract item 6) pass the checker and become SDK models.
    const responses = (await Bun.file(join(dir, 'openapi.json')).json()).paths['/api/probe'].get.responses;
    expect(responses['200'].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/ProbeAvailable' });
    expect(responses['503'].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/ProbeUnavailable' });
    expect(await diffArtifacts(root, dir)).toEqual({
      added: probeFiles,
      changed: ['apps/frontend/sdk/.ojiepermana-sdk-manifest.json', 'apps/frontend/sdk/public-api.ts', 'openapi.json'],
      removed: [],
    });
    const publicApi = await Bun.file(join(sdk, 'public-api.ts')).text();
    expect(publicApi).toContain("export type { ProbeAvailable } from './models/probe-available';");
    expect(publicApi).toContain("export type { ProbeUnavailable } from './models/probe-unavailable';");
    expect(publicApi).toContain("export { ProbeService } from './services/probe.service';");
    expect(publicApi).toContain("export { getProbe, type GetProbe$Params } from './fn/probe/get-probe';");

    // Manifest version 1 lists every generated file except itself, sorted.
    const manifest = await Bun.file(join(sdk, '.ojiepermana-sdk-manifest.json')).json();
    const generated = [...(await readArtifacts(dir)).keys()]
      .filter((path) => path.startsWith('apps/frontend/sdk/') && path !== 'apps/frontend/sdk/.ojiepermana-sdk-manifest.json')
      .map((path) => path.slice('apps/frontend/sdk/'.length))
      .sort();
    expect(manifest.version).toBe(1);
    expect(manifest.files).toEqual(generated);
    for (const path of probeFiles) expect(manifest.files).toContain(path.slice('apps/frontend/sdk/'.length));

    // Without the route the generator deletes its files. It may leave empty directories, which diffArtifacts ignores.
    await removeProbeRoute(dir);
    const removed = await run(dir, 'api:sync', { timeout: checkTimeoutMs });
    expect(removed.code, removed.output).toBe(0);
    for (const path of probeFiles) expect(await Bun.file(join(dir, path)).exists()).toBe(false);
    expect(await diffArtifacts(root, dir)).toEqual(noDifference);

    // A file the manifest does not list is left alone by the generator and reported as removed by api:check.
    const unowned = 'apps/frontend/sdk/models/unowned-probe.ts';
    const unownedText = '// Written by hand, not listed in the manifest.\n';
    await Bun.write(join(dir, unowned), unownedText);
    const kept = await run(dir, 'api:sync', { timeout: checkTimeoutMs });
    expect(kept.code, kept.output).toBe(0);
    expect(await Bun.file(join(dir, unowned)).text()).toBe(unownedText);
    expect((await Bun.file(join(sdk, '.ojiepermana-sdk-manifest.json')).json()).files).not.toContain('models/unowned-probe.ts');
    const check = await run(dir, 'api:check', { timeout: checkTimeoutMs, env: { TMPDIR: temporary } });
    expect(check.code, check.output).toBe(1);
    expectReport(check.stderr, [`removed ${unowned}`], 'OpenAPI or SDK drift detected');
    expect(await readdir(temporary)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}, heavyTestTimeoutMs);

test('SDK-005 sdk:generate refuses a file without an owner on a path it would write and leaves apps/frontend/sdk byte identical', async () => {
  const dir = await workspace();
  const before = await scratch('foundation-sdk-005-before-');
  try {
    await addProbeRoute(dir);
    const exported = await run(dir, 'api:openapi', { timeout: checkTimeoutMs });
    expect(exported.code, exported.output).toBe(0);
    const conflict = join(dir, 'apps/frontend/sdk/models/probe-available.ts');
    await Bun.write(conflict, '// Written by hand on a path the generator writes once getProbe exists.\n');
    await mkdir(join(before, 'apps/frontend'), { recursive: true });
    await cp(join(dir, 'openapi.json'), join(before, 'openapi.json'));
    await cp(join(dir, 'apps/frontend/sdk'), join(before, 'apps/frontend/sdk'), { recursive: true, verbatimSymlinks: true });

    const refused = await run(dir, 'sdk:generate', { timeout: checkTimeoutMs });
    expect(refused.timedOut).toBe(false);
    expect(typeof refused.code).toBe('number');
    expect(refused.code, refused.output).not.toBe(0);
    expect(refused.output).toContain('models/probe-available.ts');
    expect(await diffArtifacts(before, dir)).toEqual(noDifference);

    // Control: without that file the same generator run succeeds and writes the probe files.
    await rm(conflict);
    const control = await run(dir, 'sdk:generate', { timeout: checkTimeoutMs });
    expect(control.code, control.output).toBe(0);
    for (const path of probeFiles) expect(await Bun.file(join(dir, path)).exists()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(before, { recursive: true, force: true });
  }
}, heavyTestTimeoutMs);

// ---------------------------------------------------------------------------------------------------------------
// SDK-007 (AC-7), locale part: the SDK does not depend on the locale of the process that runs sdk:generate.
// Build plan step 3 runs this test once more in a Linux container.

/** Adds getChart and getHelp to the development tag of the workspace contract, shaped like getDevelopmentStatus. */
async function addLocaleOperations(dir: string): Promise<void> {
  const path = join(dir, 'openapi.json');
  const contract = await Bun.file(path).json();
  const status = contract.paths['/api/status'].get;
  contract.paths['/api/chart'] = { get: { ...structuredClone(status), operationId: 'getChart', summary: 'Locale fixture chart' } };
  contract.paths['/api/help'] = { get: { ...structuredClone(status), operationId: 'getHelp', summary: 'Locale fixture help' } };
  await Bun.write(path, canonicalJson(contract));
}

/** Names of the operation functions that `public-api.ts` exports from `fn/`, in source order. */
function operationExports(publicApi: string): string[] {
  return [...publicApi.matchAll(/export \{\s*(\w+),[^}]*\} from '\.\/fn\/[^']+';/g)].map((match) => match[1]!);
}

test('SDK-007 sdk:generate under cs_CZ.UTF-8 and en_US.UTF-8 writes byte identical SDKs that export getChart, getDevelopmentStatus, getHelp in order', async () => {
  const dirs: string[] = [];
  try {
    for (const locale of ['cs_CZ.UTF-8', 'en_US.UTF-8']) {
      const dir = await workspace();
      dirs.push(dir);
      await addLocaleOperations(dir);
      const validated = await run(dir, 'api:validate');
      expect(validated.code, validated.output).toBe(0);
      const result = await run(dir, 'sdk:generate', { timeout: checkTimeoutMs, env: { LC_ALL: locale, LANG: locale } });
      expect(result.code, result.output).toBe(0);
      const publicApi = await Bun.file(join(dir, 'apps/frontend/sdk/public-api.ts')).text();
      expect(operationExports(publicApi)).toEqual(['getChart', 'getDevelopmentStatus', 'getHelp']);
    }
    expect(await diffArtifacts(dirs[0]!, dirs[1]!)).toEqual(noDifference);
  } finally {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  }
}, heavyTestTimeoutMs);

// ---------------------------------------------------------------------------------------------------------------
// SDK-008 (AC-8): api:check regenerates every time, without a cache, git, or change detection, and CI always runs it.

/** How many times `text` occurs in `output`. */
function occurrences(output: string, text: string): number {
  return output.split(text).length - 1;
}

const stageLines = ['OpenAPI exported without listener', 'OpenAPI project checks passed', '[sdk] standalone → sdk'];

test('SDK-008 api:check runs every stage twice and passes after a backend change that leaves the contract as it is', async () => {
  const dir = await workspace();
  const temporary = await scratch('foundation-sdk-check-tmp-');
  try {
    // A new comment and a status handler that builds the same value through another expression.
    const route = join(dir, 'apps/backend/src/features/development/status.routes.ts');
    const source = await Bun.file(route).text();
    const handler = "() => ({ status: 'ok' as const })";
    const neutralHandler = "() => {\n    const status = 'ok' as const;\n    return { status };\n  }";
    expect(source).toContain(handler);
    await Bun.write(
      route,
      `// SDK-008: this comment and the handler below change the backend without changing the contract.\n${source.replace(handler, neutralHandler)}`,
    );
    expect(await Bun.file(route).text()).toContain('return { status };');
    // The changed handler still answers with the same status and body.
    const handled = await runBun(dir, [
      '-e',
      [
        "const { createApp } = await import('./apps/backend/src/app.ts');",
        "const response = await createApp('development').handle(new Request('http://foundation.test/api/status'));",
        'console.log(response.status, await response.text());',
      ].join('\n'),
    ]);
    expect(handled.code, handled.stderr).toBe(0);
    expect(handled.stdout).toBe('200 {"status":"ok"}\n');

    const before = await checkoutSnapshot(dir);
    const result = await run(dir, 'api:check', { timeout: checkTimeoutMs, env: { TMPDIR: temporary } });
    expect(result.code, result.output).toBe(0);
    expect(outputLines(result.stdout)).toContain('OpenAPI and SDK match stored artifacts across two runs');
    for (const line of stageLines) expect(occurrences(result.output, line), line).toBe(2);
    expect(reportLines(result.stderr)).toEqual([]);
    expect(await checkoutSnapshot(dir)).toBe(before);
    expect(await readdir(temporary)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}, heavyTestTimeoutMs);

type WorkflowStep = { run?: string; if?: unknown };
type Workflow = { on: Record<string, Record<string, unknown> | null>; jobs: Record<string, { if?: unknown; steps: WorkflowStep[] }> };

test('SDK-008 CI runs on every push and pull_request without path filters, and test:ci runs api:check before the SDK consumers', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(join(root, '.github/workflows/application.yml')).text()) as Workflow;
  for (const event of ['push', 'pull_request']) {
    expect(Object.hasOwn(workflow.on, event), event).toBe(true);
    const filters = workflow.on[event] ?? {};
    for (const filter of ['paths', 'paths-ignore', 'branches', 'branches-ignore', 'tags', 'tags-ignore']) {
      expect(Object.hasOwn(filters, filter), `${event} ${filter}`).toBe(false);
    }
  }
  const jobs = Object.values(workflow.jobs);
  for (const job of jobs) expect(Object.hasOwn(job, 'if')).toBe(false);
  const ciSteps = jobs.flatMap((job) => job.steps).filter((step) => step.run === 'bun run test:ci');
  expect(ciSteps).toHaveLength(1);
  expect(Object.hasOwn(ciSteps[0]!, 'if')).toBe(false);

  const { scripts } = await Bun.file(join(root, 'package.json')).json();
  const stages: string[] = scripts['test:ci'].split(' && ');
  const position = (script: string) => stages.indexOf(`bun run ${script}`);
  expect(position('api:check')).toBeGreaterThanOrEqual(0);
  for (const consumer of ['build:frontend', 'test:frontend', 'test:integration', 'test:e2e']) {
    expect(position(consumer), consumer).toBeGreaterThan(position('api:check'));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// SDK-009 (AC-9): secrets stay out of the regeneration and its artifacts, and the rules describe the SDK contract.

const bannerLines = ['/* eslint-disable */', '/* Auto-generated by @ojiepermana/angular/sdk. DO NOT EDIT. */'];

test('SDK-009 api:sync with sentinel .env files and a sentinel environment writes artifacts without secrets, workspace paths, or loopback hosts', async () => {
  const dir = await workspace({ artifacts: false });
  const filePassword = marker('sdk009filepassword');
  const fileSecret = marker('sdk009filesecret');
  const password = marker('sdk009password');
  const secret = marker('sdk009secret');
  try {
    for (const location of ['', 'apps/backend', 'apps/frontend']) {
      await Bun.write(
        join(dir, location, '.env'),
        `DATABASE_URL=postgres://sentinel_user:${filePassword}@127.0.0.1:5432/sentinel_db\nFOUNDATION_TEST_SECRET=${fileSecret}\n`,
      );
    }
    const result = await run(dir, 'api:sync', {
      timeout: checkTimeoutMs,
      env: { DATABASE_URL: `postgres://sentinel_user:${password}@127.0.0.1:5432/sentinel_db`, FOUNDATION_TEST_SECRET: secret },
    });
    expect(result.code, result.output).toBe(0);
    for (const value of [filePassword, fileSecret, password, secret]) expect(result.output).not.toContain(value);

    const checkoutPath = root.replace(/\/$/, '');
    const forbidden = [filePassword, fileSecret, password, secret, dir, await realpath(dir), checkoutPath, 'localhost', '127.0.0.1'];
    const artifacts = [...(await readArtifacts(dir)).entries()];
    expect(artifacts.map(([path]) => path)).toContain('openapi.json');
    expect(artifacts.filter(([path]) => path.startsWith('apps/frontend/sdk/')).length).toBeGreaterThan(1);
    for (const [path, entry] of artifacts) {
      expect(entry.kind, path).toBe('file');
      const text = await Bun.file(join(dir, path)).text();
      for (const value of forbidden) expect(text.includes(value), `${path} holds a forbidden value`).toBe(false);
    }
    // The secrets changed nothing: the artifacts written from empty equal the stored ones.
    expect(await diffArtifacts(root, dir)).toEqual(noDifference);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, heavyTestTimeoutMs);

test('SDK-009 every .ts file of apps/frontend/sdk starts with the two generator banner lines', async () => {
  const files = [...(await readArtifacts(root)).keys()].filter((path) => path.startsWith('apps/frontend/sdk/') && path.endsWith('.ts'));
  expect(files.length).toBeGreaterThan(0);
  for (const path of files) {
    expect((await Bun.file(join(root, path)).text()).split('\n').slice(0, 2), path).toEqual(bannerLines);
  }
});

/** `checkoutSnapshot` lines without the file hash, for comparing the list of entries. */
function entryNames(snapshot: string): string[] {
  return snapshot.split('\n').map((line) => (line.startsWith('file ') ? line.split(' ').slice(0, 2).join(' ') : line));
}

/**
 * A fixture checkout under `parent/checkout` holding every input, `.env` files at several levels, skipped folders,
 * paths that are not inputs, and one relative symlink that stays inside the checkout.
 */
async function inputFixture(parent: string): Promise<string> {
  const checkout = join(parent, 'checkout');
  const files: Record<string, string> = {
    'package.json': '{}\n',
    '.env': 'FOUNDATION_TEST_SECRET=root\n',
    '.env.local': 'FOUNDATION_TEST_SECRET=root-local\n',
    'README.md': 'not an input\n',
    'openapi.json': '{}\n',
    'scripts/tool.ts': 'export {};\n',
    'scripts/.env': 'FOUNDATION_TEST_SECRET=scripts\n',
    'scripts/.env.local': 'FOUNDATION_TEST_SECRET=scripts-local\n',
    'scripts/.envrc': 'not an env file by name\n',
    'scripts/.angular/cache.txt': 'cache\n',
    'apps/backend/src/index.ts': 'export {};\n',
    'apps/backend/src/.env': 'FOUNDATION_TEST_SECRET=backend-src\n',
    'apps/backend/.env.test': 'FOUNDATION_TEST_SECRET=backend-test\n',
    'apps/backend/node_modules/pkg/index.js': 'module.exports = {};\n',
    'apps/backend/dist/index.js': 'built\n',
    'libs/contracts/index.ts': 'export {};\n',
    'libs/.env.production': 'FOUNDATION_TEST_SECRET=libs\n',
    'apps/frontend/angular.json': '{}\n',
    'apps/frontend/sdk.config.json': '{}\n',
    'apps/frontend/.prettierrc': '{}\n',
    'apps/frontend/.editorconfig': 'root = true\n',
    'apps/frontend/.env': 'FOUNDATION_TEST_SECRET=frontend\n',
    'apps/frontend/src/main.ts': 'not an input\n',
    'apps/frontend/sdk/api.ts': 'an output, not an input\n',
  };
  for (const [path, text] of Object.entries(files)) await Bun.write(join(checkout, path), text);
  await symlink('../.env', join(checkout, 'scripts/env-link'));
  await Bun.write(join(parent, 'outside.txt'), 'outside the checkout\n');
  await mkdir(join(parent, 'outside-libs'));
  return checkout;
}

const outsideSymlink = 'API input symlink points outside the checkout';

/**
 * Symlinks `copyApiInputs` must reject, each added to `checkout` by `add` and taken away again by `restore`, with
 * the error message it must throw. The last five resolve inside the checkout on paper (`resolve(dirname(link),
 * target)`) but lead elsewhere in the workspace copy, where `node_modules` is a link to the checkout's own folder.
 */
function rejectedSymlinks(checkout: string, parent: string) {
  return [
    {
      name: 'an absolute target',
      message: outsideSymlink,
      add: () => symlink(join(checkout, '.env'), join(checkout, 'scripts/absolute-link')),
      restore: () => rm(join(checkout, 'scripts/absolute-link')),
    },
    {
      name: 'a relative target that leaves the checkout',
      message: outsideSymlink,
      add: () => symlink('../../../../outside.txt', join(checkout, 'apps/backend/src/escape-link')),
      restore: () => rm(join(checkout, 'apps/backend/src/escape-link')),
    },
    {
      name: 'the top level input libs as an absolute symlink',
      message: outsideSymlink,
      add: async () => {
        await rename(join(checkout, 'libs'), join(parent, 'libs-aside'));
        await symlink(join(parent, 'outside-libs'), join(checkout, 'libs'));
      },
      restore: async () => {
        await rm(join(checkout, 'libs'));
        await rename(join(parent, 'libs-aside'), join(checkout, 'libs'));
      },
    },
    {
      // covers: review finding, `../node_modules/../.env` reached the checkout .env through the node_modules link.
      name: 'a relative target that climbs back out of node_modules',
      message: outsideSymlink,
      add: () => symlink('../node_modules/../.env', join(checkout, 'scripts/leak-link')),
      restore: () => rm(join(checkout, 'scripts/leak-link')),
    },
    {
      name: 'a relative target into node_modules',
      message: outsideSymlink,
      add: () => symlink('../node_modules', join(checkout, 'scripts/modules-link')),
      restore: () => rm(join(checkout, 'scripts/modules-link')),
    },
    {
      // covers: review finding, `up -> ..` and `esc -> up/../..` climbed two levels above the workspace.
      name: 'a relative target that climbs through another symlink',
      message: outsideSymlink,
      add: async () => {
        await symlink('..', join(checkout, 'scripts/up'));
        await symlink('up/../..', join(checkout, 'scripts/esc'));
      },
      restore: async () => {
        await rm(join(checkout, 'scripts/up'));
        await rm(join(checkout, 'scripts/esc'));
      },
    },
    {
      name: 'a relative target that climbs above the checkout and comes back by its folder name',
      message: outsideSymlink,
      add: () => symlink(`../../${basename(checkout)}/.env`, join(checkout, 'scripts/back-link')),
      restore: () => rm(join(checkout, 'scripts/back-link')),
    },
    {
      // covers: review finding, a symlinked `apps` made `apps/backend` copy from outside the checkout.
      name: 'an input below a symlinked parent folder',
      message: 'API input path passes through an entry that is not a directory',
      add: async () => {
        await rename(join(checkout, 'apps'), join(parent, 'apps-aside'));
        await symlink(join(parent, 'apps-aside'), join(checkout, 'apps'));
      },
      restore: async () => {
        await rm(join(checkout, 'apps'));
        await rename(join(parent, 'apps-aside'), join(checkout, 'apps'));
      },
    },
  ];
}

test('SDK-009 copyApiInputs skips .env files at every level and copies an inside symlink as it is without reaching any file', async () => {
  const parent = await scratch('foundation-sdk-009-inputs-');
  try {
    const checkout = await inputFixture(parent);
    const target = join(parent, 'target');
    await mkdir(target);
    await copyApiInputs(checkout, target);

    const copied = await checkoutSnapshot(target);
    expect(entryNames(copied)).toEqual([
      'directory apps',
      'directory apps/backend',
      'directory apps/backend/src',
      'file apps/backend/src/index.ts',
      'directory apps/frontend',
      'file apps/frontend/.editorconfig',
      'file apps/frontend/.prettierrc',
      'file apps/frontend/angular.json',
      'file apps/frontend/sdk.config.json',
      'directory libs',
      'directory libs/contracts',
      'file libs/contracts/index.ts',
      'file package.json',
      'directory scripts',
      'file scripts/.envrc',
      'link scripts/env-link ../.env',
      'file scripts/tool.ts',
    ]);
    // Same bytes for every copied file, and the same target text for the symlink.
    const source = (await checkoutSnapshot(checkout)).split('\n');
    for (const line of copied.split('\n')) expect(source).toContain(line);
    // The copied link points at a .env that the copy does not hold, so it reaches no file.
    expect(await readlink(join(target, 'scripts/env-link'))).toBe('../.env');
    expect(await Bun.file(join(target, '.env')).exists()).toBe(false);
    expect(await stat(join(target, 'scripts/env-link')).then(() => 'reached', (error: NodeJS.ErrnoException) => error.code)).toBe('ENOENT');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 10_000);

test('SDK-009 copyApiInputs rejects symlinks that lead or may lead out of the checkout, and inputs below a symlinked folder, before copying', async () => {
  const parent = await scratch('foundation-sdk-009-inputs-');
  try {
    const checkout = await inputFixture(parent);
    for (const [index, symlinkCase] of rejectedSymlinks(checkout, parent).entries()) {
      await symlinkCase.add();
      const target = join(parent, `target-${index}`);
      await mkdir(target);
      const failure = await copyApiInputs(checkout, target).then(() => undefined, (error: unknown) => error);
      expect(failure, symlinkCase.name).toBeInstanceOf(Error);
      expect((failure as Error).message, symlinkCase.name).toBe(symlinkCase.message);
      expect(await readdir(target), symlinkCase.name).toEqual([]);
      await symlinkCase.restore();
    }
    // Control: with those symlinks gone the same fixture copies.
    const target = join(parent, 'target-control');
    await mkdir(target);
    await copyApiInputs(checkout, target);
    expect(await readlink(join(target, 'scripts/env-link'))).toBe('../.env');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 10_000);

// covers: AC-6 and AC-9 (`API_INPUTS`: "setiap path disalin bila ada"; `.env`, `.env.*`, `node_modules`, `dist`, and
// `.angular` are skipped at every level, so a symlink inside them is neither checked nor copied).
test('SDK-009 copyApiInputs skips absent inputs, ignores symlinks inside skipped folders, and accepts a symlink to the checkout root', async () => {
  const parent = await scratch('foundation-sdk-009-inputs-');
  try {
    const checkout = await inputFixture(parent);
    // Absent inputs: libs/ and apps/frontend/.editorconfig.
    await rm(join(checkout, 'libs'), { recursive: true });
    await rm(join(checkout, 'apps/frontend/.editorconfig'));
    // Absolute and escaping symlinks that a package manager or a build may leave inside skipped folders.
    await symlink(join(parent, 'outside.txt'), join(checkout, 'apps/backend/node_modules/pkg/absolute-link'));
    await symlink('../../../../outside.txt', join(checkout, 'apps/backend/dist/escape-link'));
    await symlink(join(parent, 'outside.txt'), join(checkout, 'scripts/.angular/absolute-link'));
    await symlink(join(parent, 'outside.txt'), join(checkout, 'scripts/.env.linked'));
    // A relative symlink to the checkout root stays inside it, and so do plain targets after a leading `..` run.
    await symlink('..', join(checkout, 'scripts/checkout-root'));
    await symlink('./tool.ts', join(checkout, 'scripts/tool-link'));
    await symlink('../../../scripts/tool.ts', join(checkout, 'apps/backend/src/tool-link'));

    const target = join(parent, 'target');
    await mkdir(target);
    await copyApiInputs(checkout, target);
    expect(entryNames(await checkoutSnapshot(target))).toEqual([
      'directory apps',
      'directory apps/backend',
      'directory apps/backend/src',
      'file apps/backend/src/index.ts',
      'link apps/backend/src/tool-link ../../../scripts/tool.ts',
      'directory apps/frontend',
      'file apps/frontend/.prettierrc',
      'file apps/frontend/angular.json',
      'file apps/frontend/sdk.config.json',
      'file package.json',
      'directory scripts',
      'file scripts/.envrc',
      'link scripts/checkout-root ..',
      'link scripts/env-link ../.env',
      'link scripts/tool-link ./tool.ts',
      'file scripts/tool.ts',
    ]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 10_000);

test('SDK-009 api:check ends with API check failed for each rejected input symlink and passes with an inside symlink to .env', async () => {
  const parent = await scratch('foundation-sdk-009-check-');
  const temporary = await scratch('foundation-sdk-check-tmp-');
  const dir = await workspace();
  try {
    await Bun.write(join(parent, 'outside.txt'), 'outside the checkout\n');
    await mkdir(join(parent, 'outside-libs'));
    await Bun.write(join(dir, '.env'), `FOUNDATION_TEST_SECRET=${marker('sdk009check')}\n`);
    for (const symlinkCase of rejectedSymlinks(dir, parent)) {
      await symlinkCase.add();
      const before = await checkoutSnapshot(dir);
      const result = await run(dir, 'api:check', { timeout: checkTimeoutMs, env: { TMPDIR: temporary } });
      expect(result.code, `${symlinkCase.name}\n${result.output}`).toBe(1);
      expect(outputLines(result.stderr)).toContain('API check failed');
      expect(reportLines(result.stderr)).toEqual([]);
      // The copy failed before any regeneration started.
      expect(result.output).not.toContain('OpenAPI exported without listener');
      expect(result.stdout).not.toContain('OpenAPI and SDK match');
      expect(await checkoutSnapshot(dir)).toBe(before);
      expect(await readdir(temporary)).toEqual([]);
      await symlinkCase.restore();
    }
    // Control: a relative symlink to ../.env that stays inside the checkout is copied, and api:check passes.
    await symlink('../.env', join(dir, 'scripts/env-link'));
    const passed = await run(dir, 'api:check', { timeout: checkTimeoutMs, env: { TMPDIR: temporary } });
    expect(passed.code, passed.output).toBe(0);
    expect(outputLines(passed.stdout)).toContain('OpenAPI and SDK match stored artifacts across two runs');
    expect(await readdir(temporary)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}, heavyTestTimeoutMs);

// covers: AC-6 ("dengan environment yang hanya berisi PATH dan HOME"), AC-9 (no `.env` or parent secret reaches the
// regeneration), and the *Pemeriksaan drift* failure column: a stage that exits non zero ends api:check with
// `API synchronization failed`, exit 1, no report line, and no second run.
test('SDK-006 SDK-009 api:check gives api:sync only PATH and HOME from its parent and ends with API synchronization failed when a stage fails', async () => {
  const dir = await workspace();
  const home = await scratch('foundation-sdk-stage-home-');
  const temporary = await scratch('foundation-sdk-check-tmp-');
  const dotenvSecret = marker('sdkstagedotenv');
  const parentOnly: Record<string, string> = {
    DATABASE_URL: `postgres://sentinel_user:${marker('sdkstagepassword')}@127.0.0.1:5432/sentinel_db`,
    FOUNDATION_TEST_SECRET: marker('sdkstagesecret'),
    LANG: 'cs_CZ.UTF-8',
    NODE_ENV: 'production',
  };
  try {
    // A root .env in the checkout, which the nested `bun run` calls of api:sync would load if it were copied.
    await Bun.write(join(dir, '.env'), `FOUNDATION_DOTENV_SECRET=${dotenvSecret}\n`);
    // sdk:generate becomes a probe under scripts/ (an API input) that records its environment, then fails.
    await Bun.write(
      join(dir, 'scripts/sdk-env-probe.ts'),
      ["await Bun.write(`${process.env['HOME']}/stage-env.json`, JSON.stringify(process.env));", 'process.exit(3);', ''].join('\n'),
    );
    const packagePath = join(dir, 'package.json');
    const manifest = await Bun.file(packagePath).json();
    manifest.scripts['sdk:generate'] = 'bun --no-env-file scripts/sdk-env-probe.ts';
    await Bun.write(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);

    const before = await checkoutSnapshot(dir);
    const result = await run(dir, 'api:check', {
      timeout: checkTimeoutMs,
      env: { HOME: home, TMPDIR: temporary, ...parentOnly },
    });
    expect(result.code, result.output).toBe(1);
    expect(outputLines(result.stderr)).toContain('API synchronization failed');
    expect(reportLines(result.stderr)).toEqual([]);
    expect(result.stdout).not.toContain('OpenAPI and SDK match');
    // The first run failed at its last stage, so the second run never started.
    expect(occurrences(result.output, 'OpenAPI project checks passed')).toBe(1);
    const secrets = [parentOnly['DATABASE_URL']!, parentOnly['FOUNDATION_TEST_SECRET']!, dotenvSecret];
    for (const value of secrets) expect(result.output).not.toContain(value);

    const stage = (await Bun.file(join(home, 'stage-env.json')).json()) as Record<string, string>;
    // `bun run` puts its own bin folders in front; the rest is the PATH that api:check received.
    expect(stage['PATH']?.endsWith(`:${process.env['PATH']!}`)).toBe(true);
    expect(stage['HOME']).toBe(home);
    for (const name of ['TMPDIR', 'FOUNDATION_DOTENV_SECRET', ...Object.keys(parentOnly)]) {
      expect(Object.hasOwn(stage, name), name).toBe(false);
    }
    const values = Object.values(stage).join('\n');
    for (const value of secrets) expect(values.includes(value)).toBe(false);

    expect(await checkoutSnapshot(dir)).toBe(before);
    expect(await readdir(temporary)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}, heavyTestTimeoutMs);

test('SDK-009 the rules refer to spec 0009 and describe api:check, the locale pin, the import boundary, the adapter contract, and the harness', async () => {
  const rules = await Bun.file(join(root, 'docs/rules/openapi-sdk.md')).text();
  for (const text of [
    '../specs/0009-sdk-sesuai-kontrak-backend/index.md',
    'pemilik tunggal',
    'OpenAPI or SDK generation is not repeatable',
    'OpenAPI or SDK drift detected',
    '`removed`',
    '.DS_Store',
    'LC_ALL=en_US.UTF-8',
    'Bentuk impor SDK',
    'check:frontend:bundle',
    'Kontrak adapter fitur',
    '@Service()',
    'sdkContractBackendUrl',
    'sdkContractClosedUrl',
    'vitest-backend.setup.ts',
  ]) {
    expect(rules.includes(text), text).toBe(true);
  }
  const angular = await Bun.file(join(root, 'docs/rules/angular.md')).text();
  expect(angular).toContain('../specs/0009-sdk-sesuai-kontrak-backend/index.md');
});
