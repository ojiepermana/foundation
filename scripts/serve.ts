import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { runDoctor, printChecks } from "./doctor";
import { clearPorts } from "./lib/ports";
import { Invocation } from "./lib/invocation";
import { captureProcess, groupAlive, processIdentity, sameProcess, type ProcessIdentity } from "./lib/process-identity";
import { STARTUP_TIMEOUT_MS, waitForReadiness, type ReadyTarget } from "./lib/readiness";
import { insideRoot, loadConfig, projectRoot, selectWorkers, servicePorts, withTimeout, type DevelopmentConfig } from "./lib/development";

export interface Service { name: string; command: string[]; cwd: string; env: NodeJS.ProcessEnv }

export function services(config: DevelopmentConfig, workers: string[], root = projectRoot): Service[] {
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development", HOST: config.host };
  // Provisioning, migration, and backup credentials (spec 0013 AC-4) and the account password of the operator command
  // (spec 0014, *Konfigurasi*) never reach a child process.
  for (const key of ["FOUNDATION_ADMIN_DATABASE_URL", "FOUNDATION_MIGRATOR_DATABASE_URL", "FOUNDATION_MIGRATOR_PASSWORD", "FOUNDATION_BACKEND_PASSWORD",
    "FOUNDATION_BACKUP_PASSWORD", "FOUNDATION_BACKUP_DATABASE_URL", "FOUNDATION_ACCOUNT_PASSWORD"]) {
    delete environment[key];
  }
  for (const worker of Object.values(config.workers)) {
    if (worker.databaseUrlEnv) delete environment[worker.databaseUrlEnv];
    for (const key of worker.env ?? []) delete environment[key];
  }
  const frontendEnvironment: NodeJS.ProcessEnv = { NODE_ENV: "development", NG_CLI_ANALYTICS: "false" };
  for (const key of ["PATH", "HOME", "USER", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SHELL", "SystemRoot"]) {
    if (process.env[key]) frontendEnvironment[key] = process.env[key];
  }
  return [
    { name: "backend", command: [process.execPath, "--no-env-file", "--watch", insideRoot(root, config.backend.entry)], cwd: root,
      env: { ...environment, PORT: String(config.backend.port) } },
    { name: "frontend", command: [Bun.which("node")!, resolve(root, "node_modules/@angular/cli/bin/ng.js"), "serve", "--host", config.host,
        "--port", String(config.frontend.port), "--proxy-config", config.frontend.proxyConfig],
      cwd: resolve(root, config.frontend.workspace), env: frontendEnvironment },
    ...workers.map((name) => ({ name: `worker:${name}`, command: [process.execPath, "--no-env-file", "--watch", insideRoot(root, config.workers[name].entry)], cwd: root,
      env: { ...frontendEnvironment, HOST: config.host,
        ...Object.fromEntries((config.workers[name].env ?? []).map((key) => [key, process.env[key]])),
        ...(config.workers[name].databaseUrlEnv === undefined ? {} : { DATABASE_URL: process.env[config.workers[name].databaseUrlEnv!] }),
        ...(config.workers[name].port === undefined ? {} : { PORT: String(config.workers[name].port) }) } })),
  ];
}

/** The HTTP checks of AC-4 and AC-5: frontend and backend always, plus each selected worker that has a port. */
export function readyTargets(config: DevelopmentConfig, workers: string[]): ReadyTarget[] {
  return [
    { name: "frontend", port: config.frontend.port, path: "/", kind: "frontend" },
    { name: "backend", port: config.backend.port, path: "/api/status", kind: "backend" },
    ...workers.flatMap((name): ReadyTarget[] => config.workers[name].port === undefined ? [] : [
      { name: `worker:${name}`, port: config.workers[name].port!, path: config.workers[name].readinessPath!, kind: "worker" },
    ]),
  ];
}

// Independent process groups let Ctrl+C also stop child build/watch processes.
export async function supervise(definitions: Service[], options: {
  onSpawn?: (group: ProcessIdentity) => Promise<void>;
  ready?: ReadyTarget[];
  onReady?: () => void;
  timeoutMs?: number;
  waitForReadiness?: typeof waitForReadiness;
} = {}): Promise<number> {
  if (!definitions.length) throw new Error("Tidak ada layanan development yang dipilih.");
  const children: ChildProcess[] = [];
  const closed: Promise<void>[] = [];
  const groups: ProcessIdentity[] = [];
  const abort = new AbortController();
  const startupAt = performance.now();
  let stopping = false;
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => { resolveDone = resolve; });
  const signalGroups = async (signal: NodeJS.Signals): Promise<boolean> => {
    let safe = true;
    for (const child of children) {
      if (!child.pid) continue;
      try {
        const group = groups.find((item) => item.pid === child.pid);
        if (!group) { child.kill(signal); continue; }
        const current = await processIdentity(group.pid);
        if (!current || !sameProcess(current, group)) {
          if (await groupAlive(group.pgid)) safe = false;
          continue;
        }
        if (!await groupAlive(group.pgid)) continue;
        process.kill(-group.pgid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") safe = false;
      }
    }
    return safe;
  };
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    abort.abort();
    if (!await signalGroups("SIGTERM")) code = 1;
    await Bun.sleep(1500);
    if (!await signalGroups("SIGKILL")) code = 1;
    try { await withTimeout(Promise.all(closed), 2000); }
    catch { code = 1; console.error("Sebagian proses development belum terkonfirmasi berhenti."); }
    resolveDone(code);
  };
  const onInterrupt = () => { void stop(130); };
  const onTerminate = () => { void stop(143); };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    for (const service of definitions) {
      if (stopping) break;
      console.log(`Menjalankan ${service.name}.`);
      const child = spawn(service.command[0], service.command.slice(1), {
        cwd: service.cwd, env: service.env, stdio: "inherit", detached: true,
      });
      children.push(child);
      closed.push(new Promise<void>((resolve) => child.once("close", () => resolve())));
      child.once("error", () => {
        console.error(`${service.name} gagal dimulai.`);
        void stop(1);
      });
      child.once("exit", (code, signal) => {
        if (!stopping) {
          console.error(`${service.name} berhenti (${signal ?? code}); menghentikan layanan lainnya.`);
          void stop(code && code > 0 ? code : 1);
        }
      });
      if (!child.pid) { await stop(1); break; }
      try {
        const group = await captureProcess(child.pid);
        if (group.pgid !== child.pid) throw new Error("Grup layanan tidak terpisah.");
        groups.push(group);
        await options.onSpawn?.(group);
      } catch {
        console.error(`${service.name} tidak dapat diverifikasi saat startup.`);
        await stop(1);
        break;
      }
    }
    if (!stopping && options.ready?.length) {
      try {
        const readiness = options.waitForReadiness ?? waitForReadiness;
        const ready = await Promise.race([
          readiness(options.ready, groups, abort.signal,
            Math.max(0, (options.timeoutMs ?? STARTUP_TIMEOUT_MS) - (performance.now() - startupAt))).then(() => true),
          done.then(() => false),
        ]);
        if (ready && !stopping) options.onReady?.();
      } catch (error) {
        console.error((error as Error).message);
        await stop(1);
      }
    }
    return await done;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

if (import.meta.main) {
  let invocation: Invocation | undefined;
  // Ctrl+C or termination before any service runs (lock, preflight, cleanup) still releases the invocation record,
  // which also puts back an old record taken for recovery (spec 0003, state transitions and AC-8). supervise()
  // installs its own handlers when the services start.
  let signalCode: number | undefined;
  let stopBeforeServices = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    stopBeforeServices = () => reject(new Error("Serve dihentikan sebelum layanan dijalankan."));
  });
  interrupted.catch(() => {});
  const onInterrupt = () => { signalCode ??= 130; stopBeforeServices(); };
  const onTerminate = () => { signalCode ??= 143; stopBeforeServices(); };
  const removeHandlers = () => { process.off("SIGINT", onInterrupt); process.off("SIGTERM", onTerminate); };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const beforeServices = <T>(task: Promise<T>): Promise<T> => Promise.race([task, interrupted]);
  const checkpoint = () => { if (signalCode !== undefined) throw new Error("Serve dihentikan sebelum layanan dijalankan."); };
  try {
    const config = await loadConfig();
    const workers = selectWorkers(process.argv.slice(2), config);
    checkpoint();
    invocation = await Invocation.acquire(projectRoot);
    checkpoint();
    if (!printChecks(await beforeServices(runDoctor(config, workers)))) process.exitCode = 1;
    else {
      await beforeServices(clearPorts(servicePorts(config, workers), invocation.staleGroups));
      await invocation.clearStale();
      checkpoint();
      removeHandlers();
      process.exitCode = await supervise(services(config, workers), {
        onSpawn: (group) => invocation!.recordGroup(group), ready: readyTargets(config, workers),
        onReady: () => {
          console.log(`Frontend: http://${config.host}:${config.frontend.port}`);
          console.log(`Backend: http://${config.host}:${config.backend.port}`);
          console.log("Layanan development siap.");
        },
      });
    }
  } catch (error) { console.error((error as Error).message); process.exitCode = signalCode ?? 1; }
  finally {
    // Handlers stay until the record is released, so a second Ctrl+C cannot cut the release short.
    try { await invocation?.release(); }
    finally {
      removeHandlers();
      if (signalCode !== undefined) process.exit(signalCode);
    }
  }
}
