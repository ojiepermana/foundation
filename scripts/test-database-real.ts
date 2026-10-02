import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const evidence = resolve(root, '.local/feature-5');
const junit = resolve(evidence, 'database.xml');
const bundle = resolve(root, 'apps/frontend/dist/frontend');
const seed = randomBytes(32).toString('hex');
const [adminPassword, migratorPassword, backendPassword] = ['admin', 'migrator', 'backend'].map((role) => createHmac('sha256', seed).update(role).digest('hex'));
const adminUrl = `postgres://foundation_admin:${adminPassword}@127.0.0.1:1/foundation`;
const migratorUrl = `postgres://foundation_migrator:${migratorPassword}@127.0.0.1:1/foundation`;
const backendUrl = `postgres://foundation_backend:${backendPassword}@127.0.0.1:1/foundation`;
const secrets = [seed, adminPassword, migratorPassword, backendPassword, adminUrl, migratorUrl, backendUrl];
const safeOutput = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);

async function run(command: string[], env: NodeJS.ProcessEnv) {
  const child = Bun.spawn(command, { cwd: root, env, stdout: 'pipe', stderr: 'pipe', timeout: 120000 });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: safeOutput(stdout + stderr) };
}

async function filesUnder(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await filesUnder(path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

try {
  await mkdir(evidence, { recursive: true });
  const baseEnv: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SHELL', 'SystemRoot', 'CI', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
    if (process.env[key]) baseEnv[key] = process.env[key];
  }
  const built = await run([process.execPath, 'run', 'build:frontend'], {
    ...baseEnv,
    DATABASE_URL: backendUrl,
    FOUNDATION_ADMIN_DATABASE_URL: adminUrl,
    FOUNDATION_MIGRATOR_DATABASE_URL: migratorUrl,
    FOUNDATION_MIGRATOR_PASSWORD: migratorPassword,
    FOUNDATION_BACKEND_PASSWORD: backendPassword,
  });
  if (built.code !== 0) throw new Error('Frontend build failed before database artifact scan');
  console.log('Frontend build for database artifact scan passed.');
  await rm(junit, { force: true });
  const tests = await run([process.execPath, '--no-env-file', 'test', './tests/integration/database', '--reporter=junit', `--reporter-outfile=${junit}`], {
    ...baseEnv, FOUNDATION_TEST_SECRET_SEED: seed,
  });
  console.log(tests.output.trim());
  const paths = [junit, ...await filesUnder(bundle)];
  const findings: string[] = [];
  for (const path of paths) {
    const data = await readFile(path);
    if (secrets.some((secret) => data.includes(Buffer.from(secret)))) findings.push(path.slice(root.length + 1));
  }
  const report = {
    filesScanned: paths.length,
    secretsChecked: secrets.length,
    junitSha256: createHash('sha256').update(await readFile(junit)).digest('hex'),
    frontendBundleFiles: paths.length - 1,
    findings,
  };
  await writeFile(resolve(evidence, 'artifact-scan.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (findings.length) throw new Error('Database test credential found in JUnit or frontend bundle');
  if (tests.code !== 0) throw new Error('Database integration tests failed');
  console.log(`Database artifact scan passed: ${report.secretsChecked} random values absent from ${report.filesScanned} files.`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
