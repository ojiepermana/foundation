import { belongsToGroup, groupAlive, processIdentity, sameProcess, signalVerifiedGroup, type ProcessIdentity } from "./process-identity";

export interface Listener { pid: number; uid: number; command: string }
export type PortOwnerState = "absent" | "owned" | "foreign";

export interface PortCleanupDependencies {
  listeners?: typeof listeners;
  signal?: typeof signalVerifiedGroup;
}

export async function listeners(port: number): Promise<Listener[]> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port tidak valid.");
  const child = Bun.spawn(["lsof", "-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpcu"], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code === 1 && !stdout && !stderr.trim()) return [];
  if (code !== 0 || stderr.trim()) throw new Error(`Gagal memeriksa listener port ${port}.`);
  const result: Listener[] = [];
  let current: Partial<Listener> | undefined;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      if (current) result.push(current as Listener);
      current = { pid: Number(line.slice(1)) };
    } else if (current && line.startsWith("u")) current.uid = Number(line.slice(1));
    else if (current && line.startsWith("c")) current.command = line.slice(1);
  }
  if (current) result.push(current as Listener);
  if (result.some((item) => !Number.isInteger(item.pid) || item.pid <= 1 || !Number.isInteger(item.uid))) {
    throw new Error(`Identitas listener port ${port} tidak lengkap.`);
  }
  return result;
}

export async function clearPorts(ports: number[], oldGroups: ProcessIdentity[],
  log: (message: string) => void = console.log, graceMs = 3000,
  dependencies: PortCleanupDependencies = {}): Promise<void> {
  const readListeners = dependencies.listeners ?? listeners;
  const signal = dependencies.signal ?? signalVerifiedGroup;
  const verifyPortOwnership = async (): Promise<boolean> => {
    const current = await occupied(ports, readListeners);
    for (const item of current) if (!await ownedGroup(item, oldGroups)) return false;
    return true;
  };
  const initial = await occupied(ports, readListeners);
  for (const item of initial) {
    const owned = await ownedGroup(item, oldGroups);
    if (!owned) throw new Error("Listener port bukan proses Foundation lama dari checkout ini.");
  }
  for (const group of oldGroups) {
    if (!sameProcess(await processIdentity(group.pid), group)) continue;
    if (!await signal(group, "SIGTERM", verifyPortOwnership)) {
      throw new Error("Identitas grup atau listener port berubah sebelum SIGTERM.");
    }
    log(`Menghentikan grup Foundation lama ${group.pgid}.`);
  }
  const deadline = Date.now() + graceMs;
  let remaining = await occupied(ports, readListeners);
  while ((remaining.length || await anyGroupAlive(oldGroups)) && Date.now() < deadline) {
    await Bun.sleep(100);
    remaining = await occupied(ports, readListeners);
  }
  const toKill = new Map<number, ProcessIdentity>();
  for (const item of remaining) {
    const owned = await ownedGroup(item, oldGroups);
    if (!owned) throw new Error("Identitas listener berubah saat cleanup; startup dihentikan.");
    toKill.set(owned.pgid, owned);
  }
  for (const group of oldGroups) {
    if (await groupAlive(group.pgid)) toKill.set(group.pgid, group);
  }
  for (const owned of toKill.values()) {
    if (!await signal(owned, "SIGKILL", verifyPortOwnership)) {
      throw new Error("Identitas grup atau listener port berubah sebelum SIGKILL.");
    }
    log(`Grup Foundation lama ${owned.pgid} belum berhenti; mengirim SIGKILL.`);
  }
  const finalDeadline = Date.now() + 1500;
  while ((await occupied(ports, readListeners)).length || await anyGroupAlive(oldGroups)) {
    if (Date.now() >= finalDeadline) throw new Error("Port project masih dipakai setelah cleanup.");
    await Bun.sleep(100);
  }
}

async function anyGroupAlive(groups: ProcessIdentity[]): Promise<boolean> {
  for (const group of groups) if (await groupAlive(group.pgid)) return true;
  return false;
}

async function occupied(ports: number[], readListeners: typeof listeners = listeners): Promise<Listener[]> {
  const found = await Promise.all(ports.map(readListeners));
  return [...new Map(found.flat().map((item) => [item.pid, item])).values()];
}

async function ownedGroup(listener: Listener, groups: ProcessIdentity[]): Promise<ProcessIdentity | null> {
  for (const group of groups) {
    if (listener.uid === group.uid && await belongsToGroup(listener.pid, group)) return group;
  }
  return null;
}

export async function inspectPortOwner(port: number, groups: ProcessIdentity[],
  readListeners: typeof listeners = listeners): Promise<PortOwnerState> {
  const found = await readListeners(port);
  if (found.length === 0) return "absent";
  for (const listener of found) {
    if (!await ownedGroup(listener, groups)) return "foreign";
  }
  return "owned";
}
