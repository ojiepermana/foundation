import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { captureProcess, processIdentity, sameProcess, type ProcessIdentity } from "./process-identity";

interface OwnerRecord {
  token: string;
  checkout: string;
  uid: number;
  supervisor: ProcessIdentity;
  groups: ProcessIdentity[];
}

function groupInCheckout(group: ProcessIdentity, checkout: string, uid: number): boolean {
  return group.uid === uid && group.pid === group.pgid &&
    (group.cwd === checkout || group.cwd.startsWith(`${checkout}${sep}`));
}

async function readOwner(directory: string): Promise<OwnerRecord | null> {
  try {
    const value = JSON.parse(await readFile(resolve(directory, "owner.json"), "utf8"));
    if (typeof value.token !== "string" || typeof value.checkout !== "string" || !Array.isArray(value.groups) ||
        !value.supervisor || !Number.isInteger(value.uid)) throw new Error("Catatan invocation tidak valid.");
    return value as OwnerRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Catatan invocation tidak dapat diverifikasi.");
  }
}

async function writeOwner(directory: string, owner: OwnerRecord): Promise<void> {
  const temporary = resolve(directory, `owner.${owner.token}.tmp`);
  await writeFile(temporary, JSON.stringify(owner), { mode: 0o600 });
  await rename(temporary, resolve(directory, "owner.json"));
}

export interface InvocationDependencies {
  /** Reads the OS identity of the old supervisor, before and again inside the recovery guard. */
  processIdentity?: typeof processIdentity;
}

export class Invocation {
  private constructor(private readonly directory: string, private readonly owner: OwnerRecord,
    readonly staleGroups: ProcessIdentity[], private staleDirectory: string | null) {}

  static async acquire(root: string, dependencies: InvocationDependencies = {}): Promise<Invocation> {
    const identity = dependencies.processIdentity ?? processIdentity;
    const checkout = await realpath(root);
    const local = resolve(checkout, ".local");
    await mkdir(local, { recursive: true });
    const directory = resolve(local, "serve.lock");
    try { await stat(resolve(local, "serve.recovery.lock"));
      throw new Error("Pemulihan serve perlu diselesaikan secara manual.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let staleDirectory: string | null = null;
    let staleGroups: ProcessIdentity[] = [];
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const deadline = Date.now() + 5000;
      let previous = await readOwner(directory);
      while (!previous && Date.now() < deadline) {
        await Bun.sleep(50);
        previous = await readOwner(directory);
      }
      if (!previous) throw new Error("Catatan serve belum lengkap; periksa proses dan hentikan secara manual.");
      if (previous.checkout !== checkout || previous.uid !== process.getuid?.()) {
        throw new Error("Catatan serve bukan milik checkout dan user ini.");
      }
      if (sameProcess(await identity(previous.supervisor.pid), previous.supervisor)) {
        throw new Error("Serve lain dari checkout ini masih aktif.");
      }
      const guard = resolve(local, "serve.recovery.lock");
      try { await mkdir(guard, { mode: 0o700 }); }
      catch { throw new Error("Pemulihan serve sedang berjalan atau perlu dihentikan secara manual."); }
      try {
        const before = await stat(directory);
        const current = await readOwner(directory);
        if (!current || current.token !== previous.token || current.checkout !== checkout ||
            sameProcess(await identity(current.supervisor.pid), current.supervisor)) {
          throw new Error("Identitas invocation berubah saat pemulihan.");
        }
        if (current.groups.some((group) => !groupInCheckout(group, checkout, current.uid))) {
          throw new Error("Grup invocation lama bukan milik checkout ini.");
        }
        const after = await stat(directory);
        if (before.ino !== after.ino || before.dev !== after.dev) throw new Error("Lock berubah saat pemulihan.");
        staleDirectory = resolve(local, `serve.stale.${randomUUID()}`);
        await rename(directory, staleDirectory);
        staleGroups = current.groups;
        await mkdir(directory, { mode: 0o700 });
      } finally { await rm(guard, { recursive: true, force: true }); }
    }
    const owner: OwnerRecord = { token: randomUUID(), checkout, uid: process.getuid?.() ?? -1,
      supervisor: await captureProcess(process.pid), groups: [] };
    try { await writeOwner(directory, owner); }
    catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    return new Invocation(directory, owner, staleGroups, staleDirectory);
  }

  async recordGroup(group: ProcessIdentity): Promise<void> {
    if (!groupInCheckout(group, this.owner.checkout, this.owner.uid)) {
      throw new Error("Grup layanan bukan milik checkout ini.");
    }
    this.owner.groups.push(group);
    await writeOwner(this.directory, this.owner);
  }

  async clearStale(): Promise<void> {
    if (this.staleDirectory) {
      await rm(this.staleDirectory, { recursive: true, force: true });
      this.staleDirectory = null;
    }
  }

  async release(): Promise<void> {
    const current = await readOwner(this.directory);
    if (current?.token !== this.owner.token) return;
    if (!this.staleDirectory) {
      await rm(this.directory, { recursive: true, force: true });
      return;
    }
    const guard = resolve(this.owner.checkout, ".local/serve.recovery.lock");
    await mkdir(guard, { mode: 0o700 });
    try {
      const again = await readOwner(this.directory);
      if (again?.token !== this.owner.token) throw new Error("Lock berubah saat pemulihan.");
      await rm(this.directory, { recursive: true, force: true });
      await rename(this.staleDirectory, this.directory);
      this.staleDirectory = null;
    } finally { await rm(guard, { recursive: true, force: true }); }
  }
}
