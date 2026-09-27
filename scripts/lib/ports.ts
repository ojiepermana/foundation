export interface Listener { pid: number; uid: number; command: string }

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

export async function clearPorts(ports: number[], log: (message: string) => void = console.log, graceMs = 3000): Promise<void> {
  const initial = new Map<number, Listener>();
  for (const port of ports) {
    for (const listener of await listeners(port)) initial.set(listener.pid, listener);
  }
  const uid = process.getuid?.();
  if ([...initial.values()].some((item) => item.uid !== uid || item.pid === process.pid || item.pid === process.ppid)) {
    throw new Error("Listener dimiliki user lain atau proses pengendali; port tidak dapat dibersihkan.");
  }
  for (const item of initial.values()) {
    log(`Menghentikan listener ${item.command} (PID ${item.pid}) pada port project.`);
    signal(item.pid, "SIGTERM");
  }
  const deadline = Date.now() + graceMs;
  let remaining = await occupied(ports);
  while (remaining.length && Date.now() < deadline) {
    await Bun.sleep(100);
    remaining = await occupied(ports);
  }
  for (const item of remaining) {
    const captured = initial.get(item.pid);
    if (!captured || captured.uid !== item.uid || captured.command !== item.command) {
      throw new Error("Port ditempati proses baru saat cleanup; startup dihentikan.");
    }
    log(`Listener PID ${item.pid} belum berhenti; mengirim SIGKILL.`);
    signal(item.pid, "SIGKILL");
  }
  const finalDeadline = Date.now() + 1500;
  while ((await occupied(ports)).length) {
    if (Date.now() >= finalDeadline) throw new Error("Port project masih dipakai setelah cleanup.");
    await Bun.sleep(100);
  }
}

async function occupied(ports: number[]): Promise<Listener[]> {
  const found = await Promise.all(ports.map(listeners));
  return [...new Map(found.flat().map((item) => [item.pid, item])).values()];
}

function signal(pid: number, name: NodeJS.Signals): void {
  try { process.kill(pid, name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
