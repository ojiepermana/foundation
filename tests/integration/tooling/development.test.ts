import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runDoctor } from "../../../scripts/doctor";
import { services, supervise } from "../../../scripts/serve";
import { insideRoot, loadConfig, selectWorkers, type DevelopmentConfig } from "../../../scripts/lib/development";
import { clearPorts, listeners } from "../../../scripts/lib/ports";

const temporaryDirectories: string[] = [];
const fixtureProcesses: ReturnType<typeof Bun.spawn>[] = [];
const descendantPids: number[] = [];
const environment = { ...process.env };

afterEach(async () => {
  for (const child of fixtureProcesses.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  for (const pid of descendantPids.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  for (const path of temporaryDirectories.splice(0)) await rm(path, { recursive: true, force: true });
  for (const key of ["DATABASE_URL", "NOTIFICATION_DATABASE_URL", "NODE_ENV", "SESSION_SECRET"]) {
    if (environment[key] === undefined) delete process.env[key];
    else process.env[key] = environment[key];
  }
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "foundation-tooling-"));
  temporaryDirectories.push(root);
  return root;
}

function config(): DevelopmentConfig {
  return {
    host: "127.0.0.1", frontend: { port: 8889, workspace: "apps/frontend", proxyConfig: "proxy.conf.json" },
    backend: { port: 8888, entry: "apps/backend/src/index.ts" },
    database: { schemas: ["common", "users", "auth"], migrationSchema: "common" }, workers: {},
  };
}

async function fixtureListener(ignoreTerm = false): Promise<{ port: number; child: ReturnType<typeof Bun.spawn> }> {
  const child = Bun.spawn([process.execPath, "-e", `
    ${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ''}
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture") });
    console.log(server.port);
  `], { stdout: "pipe", stderr: "ignore" });
  fixtureProcesses.push(child);
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await reader.read();
  reader.releaseLock();
  const port = Number(new TextDecoder().decode(first.value).trim());
  if (!port) throw new Error("Fixture listener tidak siap.");
  return { port, child };
}

test("TOOL-001 doctor reports missing prerequisites without stopping a listener or leaking credentials", async () => {
  const root = await temporaryRoot();
  const listener = await fixtureListener();
  const selected = config();
  selected.backend.port = listener.port;
  process.env.DATABASE_URL = "invalid-url-with-private-secret";
  process.env.NODE_ENV = "development";
  const checks = await runDoctor(selected, [], root);
  expect(checks.some((item) => item.name === "Entry backend" && item.status === "error")).toBe(true);
  expect(checks.some((item) => item.name === `Port ${listener.port}` && item.status === "warning")).toBe(true);
  expect(JSON.stringify(checks)).not.toContain("private-secret");
  expect((await listeners(listener.port)).some((item) => item.pid === listener.child.pid)).toBe(true);
});

test("TOOL-002 cleanup only stops the configured fixture listener", async () => {
  const target = await fixtureListener();
  const other = await fixtureListener();
  await clearPorts([target.port], () => {});
  expect(await listeners(target.port)).toEqual([]);
  expect((await listeners(other.port)).some((item) => item.pid === other.child.pid)).toBe(true);
  expect(await fetch(`http://127.0.0.1:${other.port}`).then((response) => response.text())).toBe("fixture");
});

test("TOOL-002 cleanup escalates when the fixture ignores SIGTERM", async () => {
  const target = await fixtureListener(true);
  const messages: string[] = [];
  await clearPorts([target.port], (message) => messages.push(message), 50);
  expect(messages.some((message) => message.includes("SIGKILL"))).toBe(true);
  expect(await listeners(target.port)).toEqual([]);
});

test("TOOL-003 worker selection is explicit, deduplicated, and rejects unknown workers", () => {
  const selected = config();
  selected.workers.notification = { entry: "apps/worker/notification/src/index.ts" };
  expect(selectWorkers([], selected)).toEqual([]);
  expect(selectWorkers(["--worker", "notification", "--worker=notification"], selected)).toEqual(["notification"]);
  expect(() => selectWorkers(["--worker", "missing"], selected)).toThrow("belum terdaftar");
  expect(() => selectWorkers(["--worker", "__proto__"], selected)).toThrow("belum terdaftar");
});

test("TOOL-003 service configuration isolates database credentials and uses the requested ports", () => {
  const selected = config();
  selected.workers.notification = { entry: "apps/worker/notification/src/index.ts", databaseUrlEnv: "NOTIFICATION_DATABASE_URL", schemas: ["users"] };
  selected.workers.report = { entry: "apps/worker/report/src/index.ts" };
  process.env.DATABASE_URL = "backend-private-url";
  process.env.NOTIFICATION_DATABASE_URL = "notification-private-url";
  process.env.SESSION_SECRET = "private-session-key";
  const definitions = services(selected, ["notification", "report"]);
  expect(definitions[0].env.PORT).toBe("8888");
  expect(definitions[0].env.DATABASE_URL).toBe("backend-private-url");
  expect(definitions[1].command).toContain("8889");
  expect(definitions[1].env.DATABASE_URL).toBeUndefined();
  expect(definitions[1].env.SESSION_SECRET).toBeUndefined();
  expect(definitions[2].env.DATABASE_URL).toBe("notification-private-url");
  expect(definitions[3].env.DATABASE_URL).toBeUndefined();
  expect(definitions[2].env.SESSION_SECRET).toBeUndefined();
  expect(definitions[3].env.SESSION_SECRET).toBeUndefined();
  expect(definitions.every((item) => item.env.NOTIFICATION_DATABASE_URL === undefined)).toBe(true);
});

test("TOOL-003 configuration rejects overlapping worker ports and paths outside the repository", async () => {
  const root = await temporaryRoot();
  const selected = config();
  selected.workers.notification = { entry: "apps/worker/notification/src/index.ts", port: 8888 };
  await Bun.write(resolve(root, "config/development.json"), JSON.stringify(selected));
  await expect(loadConfig(root)).rejects.toThrow("tumpang tindih");
  expect(() => insideRoot(root, "../outside.ts")).toThrow("di dalam root");
});

test("TOOL-004 service failure stops the other service and its stubborn descendant", async () => {
  const root = await temporaryRoot();
  const identityFile = resolve(root, "listener.json");
  const descendant = `
    process.on("SIGTERM", () => {});
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture") });
    console.log(JSON.stringify({ port: server.port, pid: process.pid }));
  `;
  const parent = `
    process.on("SIGTERM", () => {});
    const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(descendant)}], { stdout: "pipe", stderr: "ignore" });
    const first = await child.stdout.getReader().read();
    await Bun.write(${JSON.stringify(identityFile)}, first.value);
    await child.exited;
  `;
  const failing = `
    const deadline = Date.now() + 2000;
    while (!(await Bun.file(${JSON.stringify(identityFile)}).exists())) {
      if (Date.now() > deadline) process.exit(8);
      await Bun.sleep(20);
    }
    process.exit(7);
  `;
  const result = await supervise([
    { name: "fixture-parent", command: [process.execPath, "-e", parent], cwd: root, env: {} },
    { name: "fixture-failure", command: [process.execPath, "-e", failing], cwd: root, env: {} },
  ]);
  const identity = await Bun.file(identityFile).json();
  descendantPids.push(identity.pid);
  expect(result).toBe(7);
  expect(await listeners(identity.port)).toEqual([]);
}, 10000);
