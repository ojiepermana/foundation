import { listeners, verifyPortOwner } from "./ports";
import type { ProcessIdentity } from "./process-identity";

export interface ReadyTarget {
  name: string;
  port: number;
  path: string;
  kind: "frontend" | "backend" | "worker";
}

async function probe(target: ReadyTarget): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`http://127.0.0.1:${target.port}${target.path}`, {
      method: "GET", redirect: "manual", signal: controller.signal,
    });
    if (response.status !== 200) return false;
    if (target.kind === "frontend") {
      if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) return false;
      return /<html(?:\s|>)/i.test(await response.text());
    }
    if (target.kind === "backend") {
      if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) return false;
      const body = await response.json();
      return body && typeof body === "object" && Object.keys(body).length === 1 && body.status === "ok";
    }
    return true;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

export async function waitForReadiness(targets: ReadyTarget[], groups: ProcessIdentity[],
  signal: AbortSignal, timeoutMs = 60000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  const ready = new Set<string>();
  while (ready.size < targets.length) {
    if (signal.aborted) throw new Error("Startup dibatalkan.");
    if (performance.now() >= deadline) throw new Error("Layanan tidak siap dalam batas waktu.");
    for (const target of targets) {
      if (ready.has(target.name)) continue;
      const owned = await verifyPortOwner(target.port, groups);
      if (!owned) {
        const found = await listeners(target.port);
        if (found.length) throw new Error(`Listener ${target.name} bukan milik invocation ini.`);
        continue;
      }
      if (await probe(target)) {
        if (!await verifyPortOwner(target.port, groups)) throw new Error(`Listener ${target.name} berubah saat readiness.`);
        ready.add(target.name);
      }
    }
    if (ready.size < targets.length) await Bun.sleep(200);
  }
  for (const target of targets) {
    if (!await verifyPortOwner(target.port, groups)) throw new Error(`Listener ${target.name} berubah sebelum siap.`);
  }
}
