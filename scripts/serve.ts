import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { runDoctor, printChecks } from "./doctor";
import { clearPorts } from "./lib/ports";
import { Invocation } from "./lib/invocation";
import { captureProcess, groupAlive, processIdentity, sameProcess, type ProcessIdentity } from "./lib/process-identity";
import { waitForReadiness, type ReadyTarget } from "./lib/readiness";
import { insideRoot, loadConfig, projectRoot, selectWorkers, servicePorts, withTimeout, type DevelopmentConfig } from "./lib/development";

export interface Service { name: string; command: string[]; cwd: string; env: NodeJS.ProcessEnv }

export function services(config: DevelopmentConfig, workers: string[], root = projectRoot): Service[] {
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development", HOST: config.host };
  for (const key of ["FOUNDATION_ADMIN_DATABASE_URL", "FOUNDATION_MIGRATOR_DATABASE_URL", "FOUNDATION_MIGRATOR_PASSWORD", "FOUNDATION_BACKEND_PASSWORD"]) {
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

// Independent process groups let Ctrl+C also stop child build/watch processes.
export async function supervise(definitions: Service[], options: {
  onSpawn?: (group: ProcessIdentity) => Promise<void>;
  ready?: ReadyTarget[];
  onReady?: () => void;
  timeoutMs?: number;
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
        const ready = await Promise.race([
          waitForReadiness(options.ready, groups, abort.signal,
            Math.max(0, (options.timeoutMs ?? 60000) - (performance.now() - startupAt))).then(() => true),
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
  try {
    const config = await loadConfig();
    const workers = selectWorkers(process.argv.slice(2), config);
    invocation = await Invocation.acquire(projectRoot);
    if (!printChecks(await runDoctor(config, workers))) process.exitCode = 1;
    else {
      await clearPorts(servicePorts(config, workers), invocation.staleGroups);
      await invocation.clearStale();
      const ready: ReadyTarget[] = [
        { name: "frontend", port: config.frontend.port, path: "/", kind: "frontend" },
        { name: "backend", port: config.backend.port, path: "/api/status", kind: "backend" },
        ...workers.flatMap((name): ReadyTarget[] => config.workers[name].port === undefined ? [] : [
          { name: `worker:${name}`, port: config.workers[name].port!, path: config.workers[name].readinessPath!, kind: "worker" },
        ]),
      ];
      process.exitCode = await supervise(services(config, workers), {
        onSpawn: (group) => invocation!.recordGroup(group), ready,
        onReady: () => {
          console.log(`Frontend: http://${config.host}:${config.frontend.port}`);
          console.log(`Backend: http://${config.host}:${config.backend.port}`);
          console.log("Layanan development siap.");
        },
      });
    }
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
  finally { await invocation?.release(); }
}
