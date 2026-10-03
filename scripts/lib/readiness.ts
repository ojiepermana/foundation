import { inspectPortOwner, type PortOwnerState } from "./ports";
import type { ProcessIdentity } from "./process-identity";

export interface ReadyTarget {
  name: string;
  port: number;
  path: string;
  kind: "frontend" | "backend" | "worker";
}

export interface ReadinessDependencies {
  inspectOwner?: (port: number, groups: ProcessIdentity[]) => Promise<PortOwnerState>;
}

function assertBeforeDeadline(deadline: number): void {
  if (performance.now() >= deadline) throw new Error("Layanan tidak siap dalam batas waktu.");
}

async function probe(target: ReadyTarget, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(1500, timeoutMs));
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
  signal: AbortSignal, timeoutMs = 60000, dependencies: ReadinessDependencies = {}): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  const inspectOwner = dependencies.inspectOwner ?? inspectPortOwner;
  const ready = new Set<string>();
  while (ready.size < targets.length) {
    if (signal.aborted) throw new Error("Startup dibatalkan.");
    assertBeforeDeadline(deadline);
    for (const target of targets) {
      if (ready.has(target.name)) continue;
      assertBeforeDeadline(deadline);
      const owner = await inspectOwner(target.port, groups);
      assertBeforeDeadline(deadline);
      if (owner === "foreign") throw new Error(`Listener ${target.name} bukan milik invocation ini.`);
      if (owner === "absent") continue;
      const responded = await probe(target, deadline - performance.now());
      assertBeforeDeadline(deadline);
      if (responded) {
        if (await inspectOwner(target.port, groups) !== "owned") throw new Error(`Listener ${target.name} berubah saat readiness.`);
        assertBeforeDeadline(deadline);
        ready.add(target.name);
      }
    }
    if (ready.size < targets.length) {
      assertBeforeDeadline(deadline);
      await Bun.sleep(Math.min(200, deadline - performance.now()));
    }
  }
  for (const target of targets) {
    assertBeforeDeadline(deadline);
    if (await inspectOwner(target.port, groups) !== "owned") throw new Error(`Listener ${target.name} berubah sebelum siap.`);
    assertBeforeDeadline(deadline);
  }
}
