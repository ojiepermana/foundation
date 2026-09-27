import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { runDoctor, printChecks } from "./doctor";
import { clearPorts } from "./lib/ports";
import { insideRoot, loadConfig, projectRoot, selectWorkers, servicePorts, withTimeout, type DevelopmentConfig } from "./lib/development";

export interface Service { name: string; command: string[]; cwd: string; env: NodeJS.ProcessEnv }

export function services(config: DevelopmentConfig, workers: string[], root = projectRoot): Service[] {
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development", HOST: config.host };
  for (const worker of Object.values(config.workers)) {
    if (worker.databaseUrlEnv) delete environment[worker.databaseUrlEnv];
    for (const key of worker.env ?? []) delete environment[key];
  }
  const frontendEnvironment: NodeJS.ProcessEnv = { NODE_ENV: "development", NG_CLI_ANALYTICS: "false" };
  for (const key of ["PATH", "HOME", "USER", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SHELL", "SystemRoot"]) {
    if (process.env[key]) frontendEnvironment[key] = process.env[key];
  }
  return [
    { name: "backend", command: [process.execPath, "--watch", insideRoot(root, config.backend.entry)], cwd: root,
      env: { ...environment, PORT: String(config.backend.port) } },
    { name: "frontend", command: [Bun.which("node")!, resolve(root, "node_modules/@angular/cli/bin/ng.js"), "serve", "--host", config.host,
        "--port", String(config.frontend.port), "--proxy-config", config.frontend.proxyConfig],
      cwd: resolve(root, config.frontend.workspace), env: frontendEnvironment },
    ...workers.map((name) => ({ name: `worker:${name}`, command: [process.execPath, "--watch", insideRoot(root, config.workers[name].entry)], cwd: root,
      env: { ...frontendEnvironment, HOST: config.host,
        ...Object.fromEntries((config.workers[name].env ?? []).map((key) => [key, process.env[key]])),
        ...(config.workers[name].databaseUrlEnv === undefined ? {} : { DATABASE_URL: process.env[config.workers[name].databaseUrlEnv!] }),
        ...(config.workers[name].port === undefined ? {} : { PORT: String(config.workers[name].port) }) } })),
  ];
}

// Independent process groups let Ctrl+C also stop child build/watch processes.
export async function supervise(definitions: Service[]): Promise<number> {
  if (!definitions.length) throw new Error("Tidak ada layanan development yang dipilih.");
  const children: ChildProcess[] = [];
  const closed: Promise<void>[] = [];
  let stopping = false;
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => { resolveDone = resolve; });
  const signalGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error("Grup proses development tidak dapat dihentikan."); }
  };
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    children.forEach((child) => signalGroup(child, "SIGTERM"));
    await Bun.sleep(1500);
    children.forEach((child) => signalGroup(child, "SIGKILL"));
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
    }
    return await done;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

if (import.meta.main) {
  try {
    const config = await loadConfig();
    const workers = selectWorkers(process.argv.slice(2), config);
    if (!printChecks(await runDoctor(config, workers))) process.exitCode = 1;
    else {
      await clearPorts(servicePorts(config, workers));
      console.log(`Frontend: http://${config.host}:${config.frontend.port}`);
      console.log(`Backend: http://${config.host}:${config.backend.port}`);
      process.exitCode = await supervise(services(config, workers));
    }
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
