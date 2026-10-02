import { realpath } from "node:fs/promises";

export interface ProcessIdentity {
  pid: number;
  uid: number;
  pgid: number;
  started: string;
  cwd: string;
}

async function command(args: string[]): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, output };
}

export async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const ps = await command(["ps", "-p", String(pid), "-o", "uid=", "-o", "pgid=", "-o", "lstart="]);
  if (ps.code === 1 && !ps.output.trim()) return null;
  if (ps.code !== 0) throw new Error("Identitas proses tidak dapat diperiksa.");
  const match = ps.output.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) throw new Error("Identitas proses tidak lengkap.");
  const lsof = await command(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  if (lsof.code === 1 && !lsof.output.trim()) return null;
  if (lsof.code !== 0) throw new Error("Direktori proses tidak dapat diperiksa.");
  const path = lsof.output.split("\n").find((line) => line.startsWith("n"))?.slice(1);
  if (!path) throw new Error("Direktori proses tidak lengkap.");
  let cwd: string;
  try { cwd = await realpath(path); }
  catch { throw new Error("Direktori proses tidak dapat diverifikasi."); }
  return { pid, uid: Number(match[1]), pgid: Number(match[2]), started: match[3].replace(/\s+/g, " ").trim(), cwd };
}

export async function captureProcess(pid: number): Promise<ProcessIdentity> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const identity = await processIdentity(pid);
    if (identity) return identity;
    await Bun.sleep(10);
  }
  throw new Error("Proses baru tidak dapat diverifikasi.");
}

export function sameProcess(actual: ProcessIdentity | null, expected: ProcessIdentity): boolean {
  return actual !== null && actual.pid === expected.pid && actual.uid === expected.uid &&
    actual.pgid === expected.pgid && actual.started === expected.started && actual.cwd === expected.cwd;
}

export async function belongsToGroup(pid: number, leader: ProcessIdentity): Promise<boolean> {
  const [listener, currentLeader] = await Promise.all([processIdentity(pid), processIdentity(leader.pid)]);
  return sameProcess(currentLeader, leader) && listener !== null && listener.uid === leader.uid && listener.pgid === leader.pgid;
}

export async function signalVerifiedGroup(leader: ProcessIdentity, signal: NodeJS.Signals): Promise<boolean> {
  if (!sameProcess(await processIdentity(leader.pid), leader) || leader.pgid !== leader.pid) return false;
  try { process.kill(-leader.pgid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  return true;
}

export async function groupAlive(pgid: number): Promise<boolean> {
  const ps = await command(["ps", "-A", "-o", "pgid=", "-o", "stat="]);
  if (ps.code !== 0) throw new Error("Grup proses tidak dapat diperiksa.");
  return ps.output.split("\n").some((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)/);
    return match && Number(match[1]) === pgid && !match[2].startsWith("Z");
  });
}
