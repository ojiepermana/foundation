import { isAbsolute, relative, resolve } from "node:path";

export const projectRoot = resolve(import.meta.dir, "../..");

export interface DevelopmentConfig {
  host: string;
  frontend: { port: number; workspace: string; proxyConfig: string };
  backend: { port: number; entry: string };
  database: { expectedName: string; schemas: string[]; migrationSchema: string };
  workers: Record<string, { entry: string; port?: number; readinessPath?: string; databaseUrlEnv?: string; schemas?: string[]; env?: string[] }>;
}

export function insideRoot(root: string, path: string): string {
  const result = resolve(root, path);
  const rel = relative(root, result);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Path development harus berada di dalam root project.");
  }
  return result;
}

export async function loadConfig(root = projectRoot): Promise<DevelopmentConfig> {
  const config = await Bun.file(resolve(root, "config/development.json")).json();
  if (config.host !== "127.0.0.1") throw new Error("Serve development harus memakai host 127.0.0.1.");
  if (config.frontend?.port !== 8889 || config.backend?.port !== 8888) {
    throw new Error("Port frontend harus 8889 dan backend harus 8888.");
  }
  if (typeof config.database?.expectedName !== "string" || !/^[a-z][a-z0-9_]*$/.test(config.database.expectedName) ||
      !Array.isArray(config.database?.schemas) || !config.database.schemas.length ||
      config.database.schemas.some((schema: unknown) => typeof schema !== "string" || !/^[a-z][a-z0-9_]*$/.test(schema)) ||
      !config.database.schemas.includes(config.database.migrationSchema)) {
    throw new Error("Daftar schema dan migrationSchema development tidak valid.");
  }
  if (!config.workers || typeof config.workers !== "object" || Array.isArray(config.workers)) {
    throw new Error("workers harus berupa registry object.");
  }
  insideRoot(root, config.frontend.workspace);
  insideRoot(resolve(root, config.frontend.workspace), config.frontend.proxyConfig);
  insideRoot(root, config.backend.entry);
  const ports = new Set([8888, 8889]);
  for (const [name, worker] of Object.entries(config.workers) as [string, DevelopmentConfig["workers"][string]][]) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("Nama worker tidak valid.");
    insideRoot(root, worker.entry);
    if (worker.env !== undefined && (!Array.isArray(worker.env) || worker.env.some((key) =>
      !/^[A-Z][A-Z0-9_]*$/.test(key) || ["DATABASE_URL", "NODE_ENV", "HOST", "PORT", "PATH", "HOME", "BUN_OPTIONS", "NODE_OPTIONS"].includes(key)))) {
      throw new Error("Variable environment worker harus eksplisit dan tidak boleh menimpa konfigurasi proses.");
    }
    if (worker.databaseUrlEnv !== undefined &&
        (!/^[A-Z][A-Z0-9_]*$/.test(worker.databaseUrlEnv) || worker.databaseUrlEnv === "DATABASE_URL" ||
         !Array.isArray(worker.schemas) || !worker.schemas.length ||
         worker.schemas.some((schema) => !config.database.schemas.includes(schema)))) {
      throw new Error("Worker database memerlukan env URL terpisah dan daftar schema yang diperlukan.");
    }
    if (worker.port !== undefined) {
      if (!Number.isInteger(worker.port) || worker.port < 1024 || worker.port > 65535 || ports.has(worker.port)) {
        throw new Error("Port worker harus valid dan tidak tumpang tindih.");
      }
      if (typeof worker.readinessPath !== "string" || !validReadinessPath(worker.readinessPath)) {
        throw new Error("Worker HTTP memerlukan readinessPath lokal yang valid.");
      }
      ports.add(worker.port);
    } else if (worker.readinessPath !== undefined) {
      throw new Error("readinessPath hanya berlaku untuk worker dengan port HTTP.");
    }
  }
  return config;
}

function validReadinessPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || /[?#\s\\]/.test(path)) return false;
  try {
    const parsed = new URL(path, "http://127.0.0.1");
    return parsed.pathname === path && parsed.origin === "http://127.0.0.1";
  } catch { return false; }
}

export function selectWorkers(args: string[], config: DevelopmentConfig): string[] {
  const result = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") continue;
    let name: string | undefined;
    if (args[i] === "--worker") name = args[++i];
    else if (args[i].startsWith("--worker=")) name = args[i].slice(9);
    else throw new Error("Argumen tidak dikenal. Gunakan --worker <nama>, dapat diulang.");
    if (!name || !Object.hasOwn(config.workers, name)) {
      throw new Error("Worker belum terdaftar di config/development.json.");
    }
    result.add(name);
  }
  return [...result];
}

export function servicePorts(config: DevelopmentConfig, workers: string[]): number[] {
  return [config.backend.port, config.frontend.port,
    ...workers.flatMap((name) => config.workers[name].port === undefined ? [] : [config.workers[name].port!])];
}

export async function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Pemeriksaan melewati batas waktu.")), ms);
    })]);
  } finally {
    clearTimeout(timer!);
  }
}
