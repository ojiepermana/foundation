import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// BKP-001 (spec 0013; AC-1, AC-3, AC-4, AC-9): the static form of the backup and restore artifacts, without a container
// engine. deploy/backup.yaml through Bun.YAML.parse against *Topologi backup*; both scripts of deploy/backup/ against
// *Perintah pg_dump*, *Perintah restore*, *Urutan restore*, *Pesan script*, *Retensi*, and *Check* (the shell options,
// the traps, the stderr capture, the exact tool commands in the background with a DSN without its password, split_dsn
// run in bash on the host, environment read only as `${NAME:-}`, the category patterns in table order, the exit 124 and
// 137 mapping, the archive header checks, the constants, and the paths only this check reaches: `time limit`, `killed`,
// `archive invalid`, `internal`, and `Retention failed`; BKP-006 reaches `interrupted` with real components too);
// database/fingerprint.ts with `row_security` off and `lock_timeout`; .env.backup.example and .gitignore; and the scenario
// registry against *Critical test scenarios*; the required strings of *Dokumen yang diperbarui*, the runbook, incident
// procedure, and hook of docs/rules/backup.md, the provisioning and pre-migration steps of docs/rules/deployment.md, the
// fixed headings of *Template latihan restore*, and every drill record under docs/testing/restore-drills/ (AC-1, AC-9).
// Every check is a function that returns problems, so each test also shows that a mutated script or document is caught.
// Expected values are written here from the tables of the spec, never read back from the code under test.

const root = resolve(import.meta.dir, '../../..');
const read = (path: string) => readFile(join(root, path), 'utf8');

const BACKUP_SCRIPT = 'deploy/backup/foundation-backup.sh';
const RESTORE_SCRIPT = 'deploy/backup/foundation-restore.sh';

/** Lines that are not blank and not a comment; the shebang counts as a comment. */
function codeLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
}

/** The body of the shell function `name` (the lines between `name() {` and the `}` at column 0). */
function functionBody(text: string, name: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf(`${name}() {`);
  if (start < 0) return [];
  const end = lines.indexOf('}', start);
  return end < 0 ? [] : lines.slice(start + 1, end);
}

// ---------------------------------------------------------------------------------------------------------------
// deploy/backup.yaml (*Topologi backup*, AC-3).

const HARDENING = {
  read_only: true,
  tmpfs: ['/tmp:rw,nosuid,nodev,noexec,size=64m'],
  cap_drop: ['ALL'],
  security_opt: ['no-new-privileges:true'],
  cpus: 1,
  mem_limit: '512m',
  pids_limit: 64,
  restart: 'no',
  stop_grace_period: '30s',
  logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
};

const TOPOLOGY = {
  backup: {
    image: '${FOUNDATION_POSTGRES_IMAGE:-foundation-postgres:18-pinned}',
    profiles: ['backup'],
    entrypoint: ['/bin/bash', '/opt/foundation/foundation-backup.sh'],
    command: ['check'],
    user: '${FOUNDATION_BACKUP_UID:-26}:${FOUNDATION_BACKUP_GID:-26}',
    networks: ['data'],
    volumes: ['${FOUNDATION_BACKUP_DIR:?}:/backup', './backup/foundation-backup.sh:/opt/foundation/foundation-backup.sh:ro'],
    environment: { FOUNDATION_BACKUP_DATABASE_URL: '${FOUNDATION_BACKUP_DATABASE_URL:-}' },
    ...HARDENING,
  },
  restore: {
    image: '${FOUNDATION_POSTGRES_IMAGE:-foundation-postgres:18-pinned}',
    profiles: ['restore'],
    entrypoint: ['/bin/bash', '/opt/foundation/foundation-restore.sh'],
    user: '${FOUNDATION_BACKUP_UID:-26}:${FOUNDATION_BACKUP_GID:-26}',
    // Spec 0013 (*Topologi backup*): the restore joins only the network the shell names, never the source of the env file.
    networks: ['restore_data'],
    volumes: ['${FOUNDATION_BACKUP_DIR:?}:/backup:ro', './backup/foundation-restore.sh:/opt/foundation/foundation-restore.sh:ro'],
    ...HARDENING,
  },
};

test('BKP-001 deploy/backup.yaml equals the Topologi backup table: two one shot services, each on one external data network only, without ports, build, secrets, or depends_on', async () => {
  const compose = Bun.YAML.parse(await read('deploy/backup.yaml')) as Record<string, any>;
  // toEqual is exact on keys, so no ports, build, secrets, depends_on, volumes, or another service or network can hide.
  // The restore network has an empty default, never `:?` (which would stop the backup job too) and never the source.
  expect(compose).toEqual({
    name: 'foundation-backup',
    services: TOPOLOGY,
    networks: {
      data: { external: true, name: '${FOUNDATION_DATA_NETWORK:?}' },
      restore_data: { external: true, name: '${FOUNDATION_RESTORE_DATA_NETWORK:-}' },
    },
  });
  for (const [name, service] of Object.entries(compose['services'] as Record<string, Record<string, unknown>>)) {
    for (const key of ['ports', 'build', 'secrets', 'depends_on', 'privileged', 'cap_add', 'network_mode']) expect(Object.hasOwn(service, key), `${name}: ${key}`).toBe(false);
  }
  // The restore receives the admin DSN of the target only through `run -e` from the operator shell, never from a file.
  expect(Object.hasOwn(compose['services'].restore, 'environment')).toBe(false);
  expect(Object.hasOwn(compose['services'].restore, 'command')).toBe(false);
  // deploy/backup/ holds exactly the two scripts this file mounts, so every check below covers every script there.
  expect((await readdir(join(root, 'deploy/backup'))).sort()).toEqual(['foundation-backup.sh', 'foundation-restore.sh']);
});

// ---------------------------------------------------------------------------------------------------------------
// The shell form of both scripts (*Pesan script*, paragraph below the table, AC-3 and AC-4).

/** Lines both scripts start with, in this order, right after the comments. */
const PREAMBLE = ['set -Eeuo pipefail', 'umask 077', 'export LC_ALL=C', 'export PGCONNECT_TIMEOUT=10'];

/** The shell options, the traps, the stderr capture through fd 3, and the background runner of `script`. */
function shellProblems(text: string, script: 'backup' | 'restore'): string[] {
  const problems: string[] = [];
  const code = codeLines(text);
  if (text.split('\n')[0] !== '#!/bin/bash') problems.push('shebang');
  if (code.slice(0, PREAMBLE.length).join('\n') !== PREAMBLE.join('\n')) problems.push('preamble');
  // Every stderr line of the script goes to a file in /tmp; only report() writes, and only on fd 3.
  if (!code.includes(`exec 3>&2 2>"$WORK_DIR/foundation-${script}.err"`)) problems.push('stderr capture');
  if (functionBody(text, 'report').map((line) => line.trim()).join('\n') !== "reported=1\nprintf '%s\\n' \"$1\" >&3") problems.push('report on fd 3');
  if (code.filter((line) => line.includes('>&3')).length !== 1) problems.push('fd 3 outside report');
  for (const trap of ['trap on_exit EXIT', "trap 'on_signal 143' TERM", "trap 'on_signal 130' INT"]) if (!code.includes(trap)) problems.push(trap);
  const label = script === 'backup' ? 'Backup' : 'Restore';
  const onExit = functionBody(text, 'on_exit').map((line) => line.trim());
  if (!onExit.includes(`report '${label} failed: internal'`) || !onExit.includes('if (( status != 0 && reported == 0 )); then')) problems.push('internal');
  const onSignal = functionBody(text, 'on_signal').map((line) => line.trim());
  if (!onSignal.includes(`report '${label} failed: interrupted'`) || !onSignal.includes('kill -TERM "$child" || true') || !onSignal.includes('exit "$status"')) problems.push('interrupted');
  // The backup removes the files of its run on both paths, as long as the run is not done.
  if (script === 'backup') {
    for (const [name, body] of [['on_exit', onExit], ['on_signal', onSignal]] as const) {
      if (body.join('\n').indexOf('if (( done == 0 )); then\nremove_run_files') < 0) problems.push(`${name} removes run files`);
    }
  }
  const background = functionBody(text, 'background').map((line) => line.trim());
  if (background.join('\n') !== '"$@" &\nchild=$!\nchild_status=0\nwait "$child" || child_status=$?\nchild=\'\'') problems.push('background');
  return problems;
}

test('BKP-001 both scripts start with set -Eeuo pipefail, umask 077, LC_ALL=C, and PGCONNECT_TIMEOUT=10, send stderr to /tmp, and trap EXIT, TERM, and INT', async () => {
  const backup = await read(BACKUP_SCRIPT);
  const restore = await read(RESTORE_SCRIPT);
  expect(shellProblems(backup, 'backup')).toEqual([]);
  expect(shellProblems(restore, 'restore')).toEqual([]);
  // Mutations each check names.
  expect(shellProblems(backup.replace('set -Eeuo pipefail', 'set -euo pipefail'), 'backup')).toContain('preamble');
  expect(shellProblems(backup.replace('umask 077\n', ''), 'backup')).toContain('preamble');
  expect(shellProblems(restore.replace("trap 'on_signal 130' INT", ''), 'restore')).toContain("trap 'on_signal 130' INT");
  expect(shellProblems(restore.replace('exec 3>&2 2>"$WORK_DIR/foundation-restore.err"', ''), 'restore')).toContain('stderr capture');
  expect(shellProblems(backup.replace("  printf '%s\\n' \"$1\" >&3", "  printf '%s\\n' \"$1\" >&2"), 'backup')).toContain('report on fd 3');
  expect(shellProblems(backup.replace("report 'Backup failed: interrupted'", "report 'Backup failed: stopped'"), 'backup')).toContain('interrupted');
  expect(shellProblems(backup.replace("report 'Backup failed: internal'", "report 'Backup failed: pg_dump'"), 'backup')).toContain('internal');
  expect(shellProblems(restore.replace('  "$@" &\n', '  "$@"\n'), 'restore')).toContain('background');
});

// ---------------------------------------------------------------------------------------------------------------
// Exact tool commands (*Perintah pg_dump*, *Perintah restore*, *Urutan restore* step 6).

// `--dbname` holds the DSN without its password (`dsn_address` of split_dsn); the password reaches libpq only through
// PGPASSWORD in the environment, which other users of the host cannot read, unlike /proc/<pid>/cmdline.
const PG_DUMP = 'timeout --signal=TERM --kill-after=30s 3600 pg_dump --dbname="$dsn_address" --role=pg_read_all_data --format=custom --compress=zstd --no-password --lock-wait-timeout=30s --file=/backup/.$name.dump.partial';
const PG_RESTORE = 'timeout --signal=TERM --kill-after=30s 10800 pg_restore --dbname="$dsn_address" --clean --if-exists --single-transaction --exit-on-error --no-password /backup/$name.dump';
const PSQL = 'timeout --signal=TERM --kill-after=10s 60 psql -X -w -At -v ON_ERROR_STOP=1 --dbname="$dsn_address" -c "$1"';
/** The login role check of the backup before pg_dump (*Perintah pg_dump*, invariant 3). */
const PSQL_ROLE = "timeout --signal=TERM --kill-after=10s 60 psql -X -w -At -v ON_ERROR_STOP=1 --dbname=\"$dsn_address\" -c 'SELECT session_user'";

/**
 * Every PostgreSQL tool call of `text`: a line that names the tool as a command word followed by an option, so a header
 * text such as `Dumped by pg_dump version:` does not count.
 */
function toolCalls(text: string): string[] {
  return codeLines(text).map((line) => line.trim()).filter((line) => /(^|\s)(pg_dump|pg_restore|psql)\s+-/.test(line));
}

/** The exact commands of `script`, each in the background, and the archive list read before anything else. */
function commandProblems(text: string, script: 'backup' | 'restore'): string[] {
  const problems: string[] = [];
  const calls = toolCalls(text);
  const expected = script === 'backup'
    ? [
      `background ${PSQL_ROLE} >"$role_output" 2>"$role_errors"`,
      `background ${PG_DUMP} >"$dump_output" 2>&1`,
      'background pg_restore --list "$partial_dump" >"$list" 2>"$WORK_DIR/pg_restore.err"',
    ]
    : [
      `background ${PSQL} >"$output" 2>"$errors"`,
      'background pg_restore --list "$BACKUP_DIR/$dump" >"$list" 2>"$WORK_DIR/pg_restore.err"',
      `background ${PG_RESTORE} >"$restore_output" 2>&1`,
    ];
  if (JSON.stringify(calls) !== JSON.stringify(expected)) problems.push('tool commands');
  // The time limits of the commands equal the constants the category mapping compares with.
  const constants = script === 'backup' ? ['readonly DUMP_LIMIT_SECONDS=3600', 'readonly QUERY_LIMIT_SECONDS=60'] : ['readonly RESTORE_LIMIT_SECONDS=10800', 'readonly QUERY_LIMIT_SECONDS=60'];
  for (const constant of constants) if (!codeLines(text).includes(constant)) problems.push(constant);
  return problems;
}

test('BKP-001 pg_dump, pg_restore, and psql run exactly as Perintah pg_dump, Perintah restore, and step 6 of Urutan restore say, each in the background with a DSN without its password', async () => {
  const backup = await read(BACKUP_SCRIPT);
  const restore = await read(RESTORE_SCRIPT);
  expect(commandProblems(backup, 'backup')).toEqual([]);
  expect(commandProblems(restore, 'restore')).toEqual([]);
  // The arguments the spec rules out, and any change of the exact command, are caught.
  for (const mutation of ['--format=custom --create', '--format=custom --schema=users', '--format=custom --table=users.x', '--format=custom --enable-row-security']) {
    expect(commandProblems(backup.replace('--format=custom', mutation), 'backup'), mutation).toContain('tool commands');
  }
  expect(commandProblems(backup.replace('--lock-wait-timeout=30s', '--lock-wait-timeout=300s'), 'backup')).toContain('tool commands');
  expect(commandProblems(backup.replace(`background ${PG_DUMP}`, PG_DUMP), 'backup')).toContain('tool commands');
  expect(commandProblems(restore.replace('--single-transaction ', ''), 'restore')).toContain('tool commands');
  expect(commandProblems(restore.replace('psql -X -w -At', 'psql -X -At'), 'restore')).toContain('tool commands');
  expect(commandProblems(restore.replace('--kill-after=10s 60 psql', '--kill-after=10s 600 psql'), 'restore')).toContain('tool commands');
  expect(commandProblems(restore.replace('readonly QUERY_LIMIT_SECONDS=60', 'readonly QUERY_LIMIT_SECONDS=600'), 'restore')).toContain('readonly QUERY_LIMIT_SECONDS=60');
  // The DSN of the environment with its password in an argument is caught, for each tool.
  expect(commandProblems(backup.replace('pg_dump --dbname="$dsn_address"', 'pg_dump --dbname="$FOUNDATION_BACKUP_DATABASE_URL"'), 'backup')).toContain('tool commands');
  expect(commandProblems(restore.replace('pg_restore --dbname="$dsn_address"', 'pg_restore --dbname="$FOUNDATION_ADMIN_DATABASE_URL"'), 'restore')).toContain('tool commands');
  expect(commandProblems(restore.replace('psql -X -w -At -v ON_ERROR_STOP=1 --dbname="$dsn_address"', 'psql -X -w -At -v ON_ERROR_STOP=1 --dbname="$FOUNDATION_ADMIN_DATABASE_URL"'), 'restore')).toContain('tool commands');
  // The backup checks its login role with psql before pg_dump.
  expect(commandProblems(backup.replace(`  background ${PSQL_ROLE} >"$role_output" 2>"$role_errors"\n`, ''), 'backup')).toContain('tool commands');
});

// ---------------------------------------------------------------------------------------------------------------
// Environment and output (AC-4, *Pesan script* paragraph and invariant 6).

/**
 * The environment of a script is read only as `NAME="${NAME:-}"`, once, before any other use, and only for `allowed`.
 * Every other upper case name it uses is assigned by the script first. A DSN appears only in that assignment, in the
 * emptiness check, and as the argument of `split_dsn` (which moves its password to PGPASSWORD), so it is never echoed,
 * printed, or passed whole to a tool, whose arguments other users of the host can read.
 */
function environmentProblems(text: string, allowed: readonly string[]): string[] {
  const problems: string[] = [];
  const code = codeLines(text).map((line) => line.trim());
  const assignedAt = new Map<string, number>();
  code.forEach((line, index) => {
    const name = /^(?:readonly |export )?([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    if (name !== undefined && !assignedAt.has(name)) assignedAt.set(name, index);
  });
  code.forEach((line, index) => {
    for (const match of line.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)) {
      const name = match[1]!;
      const assigned = assignedAt.get(name);
      const own = allowed.includes(name) && line === `${name}="\${${name}:-}"`;
      if (!own && (assigned === undefined || assigned >= index)) problems.push(`environment ${name}`);
    }
  });
  for (const name of allowed) {
    const reads = code.filter((line) => line === `${name}="\${${name}:-}"`);
    if (reads.length !== 1) problems.push(`read ${name}`);
    for (const line of code) {
      if (!line.includes(`$${name}`) && !line.includes(`\${${name}`)) continue;
      const fine = line === `${name}="\${${name}:-}"`
        || new RegExp(`^\\[\\[ -n \\$${name} \\]\\] \\|\\| fail '[^']*'$`).test(line)
        || new RegExp(`^split_dsn "\\$${name}" \\|\\| fail '[^']*'$`).test(line);
      if (!fine) problems.push(`DSN ${name}`);
    }
  }
  // Any form other than `:-` (`:?` prints the name, `:=` writes it) is refused for every upper case name.
  for (const line of code) if (/\$\{[A-Z][A-Z0-9_]*(:\?|:=|:\+|\?|=|\+)/.test(line)) problems.push('expansion form');
  return [...new Set(problems)];
}

test('BKP-001 both scripts read the environment only as ${NAME:-}, once, and hand a DSN only to split_dsn, never to output or a tool argument', async () => {
  const backup = await read(BACKUP_SCRIPT);
  const restore = await read(RESTORE_SCRIPT);
  expect(environmentProblems(backup, ['FOUNDATION_BACKUP_DATABASE_URL'])).toEqual([]);
  expect(environmentProblems(restore, ['FOUNDATION_ADMIN_DATABASE_URL'])).toEqual([]);
  // The restore never reads the backup DSN, and the backup never reads the admin DSN.
  expect(backup).not.toContain('FOUNDATION_ADMIN_DATABASE_URL');
  expect(restore).not.toContain('FOUNDATION_BACKUP_DATABASE_URL');
  const echoed = backup.replace("fail 'Missing FOUNDATION_BACKUP_DATABASE_URL'", "fail 'Missing FOUNDATION_BACKUP_DATABASE_URL'\nprintf '%s\\n' \"$FOUNDATION_BACKUP_DATABASE_URL\"");
  expect(environmentProblems(echoed, ['FOUNDATION_BACKUP_DATABASE_URL'])).toContain('DSN FOUNDATION_BACKUP_DATABASE_URL');
  // The whole DSN as a tool argument is refused, like any other use.
  const whole = backup.replace('pg_dump --dbname="$dsn_address"', 'pg_dump --dbname="$FOUNDATION_BACKUP_DATABASE_URL"');
  expect(whole).not.toBe(backup);
  expect(environmentProblems(whole, ['FOUNDATION_BACKUP_DATABASE_URL'])).toContain('DSN FOUNDATION_BACKUP_DATABASE_URL');
  const required = restore.replace('FOUNDATION_ADMIN_DATABASE_URL="${FOUNDATION_ADMIN_DATABASE_URL:-}"', 'FOUNDATION_ADMIN_DATABASE_URL="${FOUNDATION_ADMIN_DATABASE_URL:?}"');
  expect(environmentProblems(required, ['FOUNDATION_ADMIN_DATABASE_URL'])).toEqual(expect.arrayContaining(['read FOUNDATION_ADMIN_DATABASE_URL', 'expansion form']));
  const other = restore.replace('readonly BACKUP_DIR=/backup', 'readonly BACKUP_DIR="$HOME/backup"');
  expect(environmentProblems(other, ['FOUNDATION_ADMIN_DATABASE_URL'])).toContain('environment HOME');
});

// ---------------------------------------------------------------------------------------------------------------
// The DSN split (*Perintah pg_dump*, *Perintah restore*, step 6 of *Urutan restore*, AC-4).

/** `percent_decode` and `split_dsn` of `text` with the globals they write, as the script defines them. */
function splitSource(text: string): string {
  const define = (name: string) => [`${name}() {`, ...functionBody(text, name), '}'].join('\n');
  return ["decoded=''", define('percent_decode'), "dsn_address=''", define('split_dsn')].join('\n');
}

type Split = { status: number; address: string; password: string };

/**
 * Runs split_dsn of `text` in bash on the host, without a container engine, once per DSN. The password comes back as
 * hexadecimal bytes, so every byte (a multi byte character included) survives the round trip.
 */
function runSplit(text: string, dsns: readonly string[]): Split[] {
  const script = `${splitSource(text)}
for dsn in "$@"; do
  status=0
  dsn_address=unset
  split_dsn "$dsn" || status=$?
  printf '%s\\t%s\\t' "$status" "$dsn_address"
  if (( status == 0 )); then printf '%s' "$PGPASSWORD" | od -An -tx1 | tr -d ' \\n'; fi
  printf '\\n'
done`;
  const result = Bun.spawnSync(['bash', '-c', script, 'split', ...dsns], { env: { PATH: process.env['PATH'] ?? '', LC_ALL: 'C' }, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error('bash could not run split_dsn');
  return result.stdout.toString().split('\n').filter((line) => line !== '').map((line) => {
    const [status = '', address = '', password = ''] = line.split('\t');
    return { status: Number(status), address, password: Buffer.from(password, 'hex').toString('utf8') };
  });
}

test('BKP-001 split_dsn keeps the password out of every tool argument: it decodes the password as libpq does into PGPASSWORD, leaves the rest of the URI to libpq, and refuses what it cannot split safely', async () => {
  const backup = await read(BACKUP_SCRIPT);
  const restore = await read(RESTORE_SCRIPT);
  // One implementation for both scripts.
  for (const name of ['percent_decode', 'split_dsn']) {
    expect(functionBody(backup, name).length, name).toBeGreaterThan(0);
    expect(functionBody(restore, name).join('\n'), name).toBe(functionBody(backup, name).join('\n'));
  }
  // PGPASSWORD is written only by split_dsn, and exported there for the tools the script starts.
  for (const text of [backup, restore]) {
    expect(codeLines(text).filter((line) => line.includes('PGPASSWORD')).map((line) => line.trim())).toEqual(['export PGPASSWORD=$decoded']);
    expect(functionBody(text, 'split_dsn').map((line) => line.trim())).toContain('export PGPASSWORD=$decoded');
  }
  // The split comes before the first tool that connects: the login role check and pg_dump of the backup, and step 6
  // of the restore (*Urutan restore* order, checked below); the role check comes before the first file of the run.
  const lines = codeLines(backup).map((line) => line.trim());
  const at = (line: string) => lines.indexOf(line);
  const order = [
    "split_dsn \"$FOUNDATION_BACKUP_DATABASE_URL\" || fail 'Backup failed: invalid connection string'",
    `background ${PSQL_ROLE} >"$role_output" 2>"$role_errors"`,
    "[[ $(<\"$role_output\") == foundation_backup ]] || fail 'Backup failed: permission denied'",
    'run_files+=("$partial_dump")',
    `background ${PG_DUMP} >"$dump_output" 2>&1`,
  ].map(at);
  expect(order.filter((index) => index < 0)).toEqual([]);
  expect([...order].sort((a, b) => a - b)).toEqual(order);

  const hex = 'c0ffee00decaf'.repeat(2);
  const reserved = `${hex} @:/?#[]%&=+$,;ü`;
  const accepted: Array<[string, string, string]> = [
    [`postgres://foundation_backup:${hex}@postgres:5432/foundation`, 'postgres://foundation_backup@postgres:5432/foundation', hex],
    [`postgres://u:${encodeURIComponent(reserved)}@postgres:5432/foundation?sslmode=disable&application_name=a%20b`, 'postgres://u@postgres:5432/foundation?sslmode=disable&application_name=a%20b', reserved],
    ['postgresql://u:p%41ss@h/db', 'postgresql://u@h/db', 'pAss'],
    ['postgres://u:%c3%BC@h/db', 'postgres://u@h/db', 'ü'],
    ['postgres://u:a:b@h/db', 'postgres://u@h/db', 'a:b'],
    ['postgres://u:@h/db', 'postgres://u@h/db', ''],
    ['postgres://u@h/db', 'postgres://u@h/db', ''],
    ['postgres://h:5432/db', 'postgres://h:5432/db', ''],
    // libpq reads userinfo only before the first '/', so this '@' belongs to the database name and nothing is split.
    ['postgres://h/db@x', 'postgres://h/db@x', ''],
  ];
  const refused = [
    'postgres://u:a b@h/db', 'postgres://u:ab%zz@h/db', 'postgres://u:ab%0@h/db', 'postgres://u:ab%00@h/db', 'postgres://u:ab%@h/db',
    'host=h user=u password=p', 'POSTGRES://u:p@h/db', 'mysql://u:p@h/db', '',
    'postgres://u@h/db?password=p', 'postgres://u@h/db?sslmode=disable&pass%77ord=p', 'postgres://u@h/db?pass word=p',
  ];
  const results = runSplit(backup, [...accepted.map(([dsn]) => dsn), ...refused]);
  expect(results.slice(0, accepted.length)).toEqual(accepted.map(([, address, password]) => ({ status: 0, address, password })));
  expect(results.slice(accepted.length).map((result) => result.status)).toEqual(refused.map(() => 1));
  // Mutations: without the space rule or the %00 rule, the broken password would be split instead of refused.
  const spaced = backup.replace("  [[ $value != *' '* ]] || return 1\n", '');
  expect(spaced).not.toBe(backup);
  expect(runSplit(spaced, ['postgres://u:a b@h/db'])[0]?.status).toBe(0);
  const nul = backup.replace(' && $hex != 00 ]] || return 1', ' ]] || return 1');
  expect(nul).not.toBe(backup);
  expect(runSplit(nul, ['postgres://u:ab%00@h/db'])[0]?.status).toBe(0);
});

/** Commands the scripts must never hold (*Pesan script* paragraph, *Perintah pg_dump*, AC-3, invariant 7). */
const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
  ['set -x', /\bset\s+-[a-zA-Z]*x/],
  ['env', /(^|[\s;|&(])env(\s|$)/],
  ['printenv', /\bprintenv\b/],
  ['declare -p', /\bdeclare\s+-[a-zA-Z]*p/],
  ['echo', /\becho\b/],
  ['pg_dumpall', /\bpg_dumpall\b/],
  ['--create', /--create\b/],
  ['--schema', /--schema\b/],
  ['--table', /--table\b/],
  ['--enable-row-security', /--enable-row-security\b/],
  ['--globals-only', /--globals-only\b/],
  ['--roles-only', /--roles-only\b/],
  ['network tool', /(^|[\s;|&(])(curl|wget|scp|sftp|ftp|rsync|rclone|aws|gsutil|az|ssh|nc|ncat|socat|telnet)(\s|$)/],
  ['raw socket', /\/dev\/(tcp|udp)\//],
  ['copy', /(^|[\s;|&(])(cp|tar|dd|install|ln|tee)(\s|$)/],
];

function forbiddenProblems(text: string): string[] {
  const code = codeLines(text);
  return FORBIDDEN.filter(([, pattern]) => code.some((line) => pattern.test(line))).map(([label]) => label);
}

test('BKP-001 neither script nor deploy/backup.yaml prints the environment, uses pg_dumpall or a filtering argument, calls a network tool, or copies a backup out of /backup', async () => {
  const backup = await read(BACKUP_SCRIPT);
  const restore = await read(RESTORE_SCRIPT);
  expect(forbiddenProblems(backup)).toEqual([]);
  expect(forbiddenProblems(restore)).toEqual([]);
  expect(forbiddenProblems(await read('deploy/backup.yaml'))).toEqual([]);
  // Files only move inside /backup: every mv of the backup moves a .partial of this run to its final name there, and the
  // restore, whose folder is mounted read only, neither moves nor removes a file.
  const moves = codeLines(backup).map((line) => line.trim()).filter((line) => /(^|\s)mv\s/.test(line));
  expect(moves).toEqual(['mv -- "$partial_dump" "$BACKUP_DIR/$dump"', 'mv -- "$partial_checksum" "$BACKUP_DIR/$checksum"', 'mv -- "$partial_manifest" "$BACKUP_DIR/$manifest"']);
  expect(codeLines(restore).filter((line) => /(^|\s)(mv|rm)\s/.test(line))).toEqual([]);
  // Each pattern catches the form it names.
  const cases: Array<[string, string]> = [
    ['set -x', 'set -x'], ['set -x', 'set -ex'], ['env', 'env | sort'], ['printenv', 'printenv FOUNDATION_BACKUP_DATABASE_URL'],
    ['declare -p', 'declare -p'], ['echo', 'echo "$x"'], ['pg_dumpall', 'pg_dumpall --globals-only'], ['--create', 'pg_dump --create'],
    ['--schema', 'pg_dump --schema=users'], ['--table', 'pg_dump --table=x'], ['--enable-row-security', 'pg_dump --enable-row-security'],
    ['network tool', 'curl -T dump https://x'], ['network tool', 'aws s3 cp a b'], ['network tool', 'rclone copy a b'], ['network tool', 'az storage blob upload'],
    ['raw socket', 'exec 3<>/dev/tcp/1.1.1.1/443'], ['copy', 'cp -- a /tmp/b'], ['copy', 'tar -cf - /backup'],
  ];
  for (const [label, line] of cases) expect(forbiddenProblems(`${line}\n`), line).toContain(label);
  for (const line of ['background pg_restore --list x', "grep -qF -e 'lock timeout' -- x", 'printf \'%s\\n\' "$1" >&3', 'environment=1']) {
    expect(forbiddenProblems(`${line}\n`), line).toEqual([]);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Failure categories (*Pesan script*, rows Gagal and the restore row).

/** Categories in the order of the *Pesan script* table, with the patterns of each in that order. */
const CATEGORIES: ReadonlyArray<[string, readonly string[]]> = [
  ['invalid connection string', ['invalid URI', 'invalid connection option', 'invalid integer value', 'unexpected spaces', 'invalid percent-encoded', 'missing "="']],
  ['connection', ['password authentication failed', 'connection to server', 'could not translate host name', 'timeout expired']],
  ['row level security', ['row-level security']],
  ['lock timeout', ['canceling statement due to statement timeout', 'lock timeout', 'could not obtain lock']],
  ['permission denied', ['permission denied']],
  ['time limit', []],
  ['killed', []],
];

/**
 * The branches of `category()` in order: the patterns of each `grep` branch with the category it prints, then the two
 * exit code branches, then the fallback. Returns problems against CATEGORIES and the exit mapping of *Pesan script*.
 */
function categoryProblems(text: string): string[] {
  const problems: string[] = [];
  const body = functionBody(text, 'category').join('\n');
  if (!body.startsWith('  local output=$1 code=$2 elapsed=$3 limit=$4 fallback=$5\n')) problems.push('arguments');
  const groups: Array<[string, string[]]> = [];
  let patterns: string[] = [];
  for (const match of body.matchAll(/-e '([^']*)'|printf '%s\\n' '([^']*)'/g)) {
    if (match[1] !== undefined) patterns.push(match[1]);
    else {
      groups.push([match[2]!, patterns]);
      patterns = [];
    }
  }
  if (JSON.stringify(groups) !== JSON.stringify(CATEGORIES)) problems.push('category order');
  // Exit 124, or 137 once the time limit has passed, is `time limit`; 137 before it is `killed`; then the fallback.
  const tail = body.slice(body.indexOf("printf '%s\\n' 'permission denied'"));
  const expectedTail = [
    "printf '%s\\n' 'permission denied'",
    '  elif (( code == 124 || (code == 137 && elapsed >= limit * 1000) )); then',
    "    printf '%s\\n' 'time limit'",
    '  elif (( code == 137 )); then',
    "    printf '%s\\n' 'killed'",
    '  else',
    '    printf \'%s\\n\' "$fallback"',
    '  fi',
  ].join('\n');
  if (tail !== expectedTail) problems.push('exit mapping');
  return problems;
}

test('BKP-001 the category patterns follow the Pesan script table in order, with exit 124 and 137 mapped to time limit and killed against the time limit', async () => {
  const backup = await read(BACKUP_SCRIPT);
  const restore = await read(RESTORE_SCRIPT);
  expect(categoryProblems(backup)).toEqual([]);
  expect(categoryProblems(restore)).toEqual([]);
  // The restore maps failures with the same patterns in the same order (*Pesan script*, row Restore Gagal).
  expect(functionBody(restore, 'category').join('\n')).toBe(functionBody(backup, 'category').join('\n'));
  // Each call passes the measured duration in ms and the time limit of the command it ran, with its fallback.
  expect(codeLines(backup).filter((line) => line.includes('$(category ')).map((line) => line.trim())).toEqual([
    'fail "Backup failed: $(category "$role_errors" "$child_status" "$(( ended - started ))" "$QUERY_LIMIT_SECONDS" pg_dump)"',
    'fail "Backup failed: $(category "$dump_output" "$child_status" "$(( ended - started ))" "$DUMP_LIMIT_SECONDS" pg_dump)"',
  ]);
  expect(codeLines(restore).filter((line) => line.includes('$(category ')).map((line) => line.trim())).toEqual([
    'kind=$(category "$errors" "$child_status" "$(( ended - started ))" "$QUERY_LIMIT_SECONDS" pg_restore)',
    'fail "Restore failed: $(category "$restore_output" "$child_status" "$(( ended - started ))" "$RESTORE_LIMIT_SECONDS" pg_restore)"',
  ]);
  // A connection failure of the identity query is `Restore target unavailable`, any other category `Restore failed`.
  expect(functionBody(restore, 'query').map((line) => line.trim()).join('\n')).toContain("if [[ $kind == connection ]]; then\nfail 'Restore target unavailable'\nfi\nfail \"Restore failed: $kind\"");
  // Mutations: a swapped pair of categories, a dropped pattern, and the 137 rule without the time limit are caught.
  expect(categoryProblems(backup.replace("-e 'row-level security'", "-e 'row-level security' -e 'permission denied'"))).toContain('category order');
  expect(categoryProblems(backup.replace(" -e 'canceling statement due to statement timeout'", ''))).toContain('category order');
  expect(categoryProblems(backup.replace('(code == 137 && elapsed >= limit * 1000)', 'code == 137'))).toContain('exit mapping');
  expect(categoryProblems(restore.replace("printf '%s\\n' 'killed'", "printf '%s\\n' 'time limit'"))).toEqual(expect.arrayContaining(['category order', 'exit mapping']));
});

// ---------------------------------------------------------------------------------------------------------------
// Archive header, checksum, and the restore order (*Nama dan isi backup*, *Urutan restore*, AC-3 and AC-6).

/** Index of the first code line of `text` that equals `line` after trimming, or -1. */
function lineIndex(text: string, line: string): number {
  return codeLines(text).findIndex((item) => item.trim() === line);
}

/** The archive checks of the backup run before the first mv, so a failed check never leaves a file behind. */
function headerProblems(text: string): string[] {
  const problems: string[] = [];
  const firstMove = codeLines(text).findIndex((line) => line.trim().startsWith('mv -- '));
  const before = (line: string, label: string) => {
    const index = lineIndex(text, line);
    if (index < 0 || firstMove < 0 || index > firstMove) problems.push(label);
  };
  before("(( child_status == 0 )) || fail 'Backup failed: archive invalid'", 'archive invalid exit');
  before('if [[ ! $server_version =~ $VERSION_PATTERN || ! $dump_version =~ $VERSION_PATTERN ]]; then', 'archive invalid versions');
  before(`if ! grep -qx -- ';     dbname: foundation' "$list" || ! grep -qE -- "$TOC_MIGRATIONS" "$list"; then`, 'wrong database');
  if (!codeLines(text).includes("readonly TOC_MIGRATIONS='^[0-9]+; [0-9]+ [0-9]+ TABLE DATA common schema_migrations( |$)'")) problems.push('TABLE DATA common schema_migrations');
  if (!codeLines(text).includes("readonly VERSION_PATTERN='^[0-9]+(\\.[0-9]+)?$'")) problems.push('version pattern');
  const lines = codeLines(text).map((line) => line.trim());
  const wrong = lines.indexOf(`if ! grep -qx -- ';     dbname: foundation' "$list" || ! grep -qE -- "$TOC_MIGRATIONS" "$list"; then`);
  if (wrong < 0 || lines[wrong + 1] !== "fail 'Backup failed: wrong database'") problems.push('wrong database message');
  const versions = lines.indexOf('if [[ ! $server_version =~ $VERSION_PATTERN || ! $dump_version =~ $VERSION_PATTERN ]]; then');
  if (versions < 0 || lines[versions + 1] !== "fail 'Backup failed: archive invalid'") problems.push('archive invalid message');
  return problems;
}

test('BKP-001 the backup checks the archive header for versions, dbname foundation, and TABLE DATA common schema_migrations before any mv', async () => {
  const backup = await read(BACKUP_SCRIPT);
  expect(headerProblems(backup)).toEqual([]);
  expect(headerProblems(backup.replace("fail 'Backup failed: wrong database'", "fail 'Backup failed: pg_dump'"))).toContain('wrong database message');
  expect(headerProblems(backup.replace('TABLE DATA common schema_migrations', 'TABLE DATA common'))).toContain('TABLE DATA common schema_migrations');
  // Moving the header check after the first mv would leave files on failure.
  const late = backup
    .replace(`  if ! grep -qx -- ';     dbname: foundation' "$list" || ! grep -qE -- "$TOC_MIGRATIONS" "$list"; then\n    fail 'Backup failed: wrong database'\n  fi\n`, '')
    .replace('  sync\n', `  sync\n  if ! grep -qx -- ';     dbname: foundation' "$list" || ! grep -qE -- "$TOC_MIGRATIONS" "$list"; then\n    fail 'Backup failed: wrong database'\n  fi\n`);
  expect(late).not.toBe(backup);
  expect(headerProblems(late)).toContain('wrong database');
});

/** The fixed checksum line of *Nama dan isi backup*, checked before `sha256sum --check --strict`. */
const CHECKSUM_LINE = 'if [[ ${#checksum_lines[@]} -ne 1 || ! ${checksum_lines[0]} =~ ^[0-9a-f]{64}\\ \\ ${name}\\.dump$ ]]; then';
const CHECKSUM_CHECK = 'if ! (cd "$BACKUP_DIR" && sha256sum --check --strict --status "$name.dump.sha256"); then';

function checksumProblems(text: string): string[] {
  const problems: string[] = [];
  const line = lineIndex(text, CHECKSUM_LINE);
  const check = lineIndex(text, CHECKSUM_CHECK);
  if (line < 0) problems.push('checksum line');
  if (check < 0) problems.push('sha256sum --check --strict');
  if (line >= 0 && check >= 0 && line > check) problems.push('line before check');
  return problems;
}

/** The restore checks of *Urutan restore*, in order, each with its message, before the one pg_restore that writes. */
const RESTORE_ORDER = [
  '[[ $# -eq 1 ]] || fail "$USAGE"',
  "fail 'Invalid backup name'",
  "[[ -n $FOUNDATION_ADMIN_DATABASE_URL ]] || fail 'Missing FOUNDATION_ADMIN_DATABASE_URL'",
  'fail "Backup incomplete: $name"',
  CHECKSUM_LINE,
  CHECKSUM_CHECK,
  'fail "Backup archive invalid: $name"',
  "split_dsn \"$FOUNDATION_ADMIN_DATABASE_URL\" || fail 'Restore failed: invalid connection string'",
  "fail 'Invalid restore target'",
  "fail 'Backup major version mismatch'",
  "[[ $query_result == t ]] || fail 'Restore target not provisioned'",
  "[[ $query_result == t ]] || fail 'Restore target not empty'",
  `background ${PG_RESTORE} >"$restore_output" 2>&1`,
  "printf 'Restore completed: %s\\n' \"$dump\"",
];

test('BKP-001 the checksum line is checked before sha256sum --check --strict, the restore runs the ten steps of Urutan restore in order, and it never reads the manifest', async () => {
  const backup = await read(BACKUP_SCRIPT);
  const restore = await read(RESTORE_SCRIPT);
  expect(checksumProblems(backup)).toEqual([]);
  expect(checksumProblems(restore)).toEqual([]);
  expect(checksumProblems(restore.replace('^[0-9a-f]{64}\\ \\ ${name}', '^[0-9a-f]{64}\\ \\ .*'))).toContain('checksum line');
  const indexes = RESTORE_ORDER.map((line) => codeLines(restore).findIndex((item) => item.trim() === line));
  expect(indexes.filter((index) => index < 0)).toEqual([]);
  expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
  // Step 7 compares the target major with the major of the header (the dump), never with the manifest.
  expect(codeLines(restore).map((line) => line.trim())).toContain('readonly backup_major=${dumped_from%%.*}');
  // The manifest is only tested to exist as a regular file (step 3); nothing reads it.
  const json = codeLines(restore).filter((line) => line.includes('.json'));
  expect(json.map((line) => line.trim())).toEqual(['for file in "$dump" "$name.dump.sha256" "$name.json"; do']);
  for (const word of ['serverVersion', 'pgDumpVersion', 'jq', 'manifest']) expect(codeLines(restore).some((line) => line.includes(word)), word).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------
// Retention and check constants (*Retensi*, *Check*, AC-7), and `Retention failed`.

const RETENTION_LINES = [
  "readonly PARTIAL_PATTERN='^\\.foundation-[0-9]{8}T[0-9]{6}Z-(scheduled|pre-migration|manual)\\.(dump|dump\\.sha256|json)\\.partial$'",
  '[[ $file =~ $PARTIAL_PATTERN ]] || continue',
  'readonly RETENTION_KEEP=7',
  'readonly RETENTION_DAYS=35',
  'readonly LEFTOVER_SECONDS=86400',
  'readonly CHECK_LIMIT_SECONDS=93600',
  'if (( kept <= RETENTION_KEEP )); then',
  'if (( age > RETENTION_DAYS * 86400 )); then',
  'if (( age > LEFTOVER_SECONDS )); then',
  'if (( age > CHECK_LIMIT_SECONDS )); then',
  'fail "Latest backup too old: $name ($(( age / 3600 )) h old)"',
  'printf \'Latest backup: %s (%s h old)\\n\' "$name" "$(( age / 3600 ))"',
];

/** The constants and comparisons of retention and check, and `Retention failed` after a complete, done backup. */
function retentionProblems(text: string): string[] {
  const problems: string[] = [];
  for (const line of RETENTION_LINES) if (lineIndex(text, line) < 0) problems.push(line);
  // Every step of retention that can fail returns 1 at once, and create prints `Retention failed` only after the new
  // backup is done and reported, so a failed retention never removes it.
  const retention = functionBody(text, 'retention').map((line) => line.trim());
  for (const line of retention.filter((item) => /^(rm|printf|now=|age=\$\(stamp_age|mtime=|list_complete)/.test(item))) {
    if (!line.endsWith('|| return 1')) problems.push(`unchecked: ${line}`);
  }
  if (!retention.includes('rm -- "$BACKUP_DIR/$name.json" || return 1')) problems.push('manifest first');
  const order = ['done=1', "printf 'Backup created: %s (%s bytes, sha256 %s)\\n' \"$dump\" \"$size\" \"$hash\"", 'if ! retention; then', "fail 'Retention failed'"]
    .map((line) => lineIndex(text, line));
  if (order.some((index) => index < 0) || order.some((index, position) => position > 0 && index <= order[position - 1]!)) problems.push('Retention failed');
  return problems;
}

test('BKP-001 retention keeps 7, removes after 35 days, removes leftovers after 24 hours only under names create writes, check passes up to 93600 s inclusive, and Retention failed comes after Backup created', async () => {
  const backup = await read(BACKUP_SCRIPT);
  expect(retentionProblems(backup)).toEqual([]);
  // Names sort by stamp only under LC_ALL=C (*Retensi*), set in the preamble checked above.
  expect(codeLines(backup)).toContain('export LC_ALL=C');
  expect(retentionProblems(backup.replace('readonly RETENTION_KEEP=7', 'readonly RETENTION_KEEP=6'))).toContain('readonly RETENTION_KEEP=7');
  expect(retentionProblems(backup.replace('readonly CHECK_LIMIT_SECONDS=93600', 'readonly CHECK_LIMIT_SECONDS=86400'))).toContain('readonly CHECK_LIMIT_SECONDS=93600');
  expect(retentionProblems(backup.replace('if (( age > CHECK_LIMIT_SECONDS )); then', 'if (( age >= CHECK_LIMIT_SECONDS )); then'))).toContain('if (( age > CHECK_LIMIT_SECONDS )); then');
  expect(retentionProblems(backup.replace('rm -- "$path" || return 1', 'rm -- "$path"'))).toContain('unchecked: rm -- "$path"');
  expect(retentionProblems(backup.replace("fail 'Retention failed'", "fail 'Backup failed: internal'"))).toContain('Retention failed');
  // A .partial is touched and printed only when its whole name is one create writes (*Retensi* item 5).
  expect(retentionProblems(backup.replace('      [[ $file =~ $PARTIAL_PATTERN ]] || continue\n', ''))).toContain('[[ $file =~ $PARTIAL_PATTERN ]] || continue');
  // The pattern itself: names create writes match, a name with a line break or another middle part does not.
  const pattern = /^readonly PARTIAL_PATTERN='(.*)'$/.exec(codeLines(backup).find((line) => line.startsWith('readonly PARTIAL_PATTERN=')) ?? '')?.[1];
  const partial = new RegExp(pattern ?? '$^');
  for (const name of ['.foundation-20261006T020000Z-scheduled.dump.partial', '.foundation-20261006T020000Z-pre-migration.dump.sha256.partial', '.foundation-20261006T020000Z-manual.json.partial']) {
    expect(partial.test(name), name).toBe(true);
  }
  for (const name of ['.foundation-x\nBackup created: foundation-20261006T020000Z-manual.dump (1 bytes, sha256 0)\n.partial', '.foundation-notes.partial', '.foundation-20261006T020000Z-weekly.dump.partial', '.foundation-20261006T020000Z-manual.tar.partial', '.foundation-20261006T020000Z-manual.dump.partial\n']) {
    expect(partial.test(name), JSON.stringify(name)).toBe(false);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Fingerprint, configuration example, and .gitignore (*Fingerprint*, *Configuration required*, AC-4).

test('BKP-001 database/fingerprint.ts switches to pg_read_all_data with row_security off and a 30 second lock_timeout inside one read only transaction', async () => {
  // Code lines only: the header comment names the same statements.
  const code = (await read('database/fingerprint.ts')).split('\n').map((line) => line.trim()).filter((line) => !/^(\/\/|\/\*|\*)/.test(line));
  const at = (text: string) => code.findIndex((line) => line.includes(text));
  const steps = ["SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY", 'SET LOCAL ROLE pg_read_all_data', 'SET LOCAL row_security = off'].map(at);
  expect(steps.filter((index) => index < 0)).toEqual([]);
  expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  for (const setting of ["SET LOCAL lock_timeout = '30s'", "SET LOCAL TimeZone = 'UTC'", "SET LOCAL DateStyle = 'ISO, YMD'", "SET LOCAL IntervalStyle = 'postgres'", 'SET LOCAL extra_float_digits = 1', "SET LOCAL bytea_output = 'hex'"]) {
    expect(at(setting), setting).toBeGreaterThan(steps[2]!);
  }
});

/** Variable lines of an env example: neither blank nor a comment. */
const variableLines = (text: string) => text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));

test('BKP-001 .env.backup.example names every .env.backup variable of Configuration required without a value, and .gitignore keeps only the example', async () => {
  const text = await read('.env.backup.example');
  expect(variableLines(text)).toEqual([
    'FOUNDATION_BACKUP_DATABASE_URL=', 'FOUNDATION_BACKUP_DIR=', 'FOUNDATION_DATA_NETWORK=',
    'FOUNDATION_POSTGRES_IMAGE=', 'FOUNDATION_BACKUP_UID=', 'FOUNDATION_BACKUP_GID=',
  ]);
  // The provisioning password, the admin DSN of a restore, and the network of the restore target stay in the operator
  // shell only; the restore network in this file would let a restore join a network without naming it in the shell.
  for (const name of ['FOUNDATION_BACKUP_PASSWORD', 'FOUNDATION_ADMIN_DATABASE_URL', 'FOUNDATION_RESTORE_DATA_NETWORK']) expect(text).not.toContain(`${name}=`);
  const ignored = variableLines(await read('.gitignore'));
  expect(ignored).toContain('.env.*');
  expect(ignored).toContain('!.env.backup.example');
  expect(ignored).not.toContain('!.env.backup');
});

// ---------------------------------------------------------------------------------------------------------------
// Scenario registry (*Critical test scenarios*, AC-8).

type Registry = { source: string; scenarios: { id: string; criteria: string[]; critical?: boolean; checks: { runner: string; file: string; testTag?: string; script: string }[] }[] };

test('BKP-001 the scenario registry names BKP-001 to BKP-008 with the runner, script, file, and criteria of Critical test scenarios, and BKP-009 of spec 0014 after them', async () => {
  const spec = await read('docs/specs/0013-backup-pemulihan-data/index.md');
  const section = spec.slice(spec.indexOf('**Critical test scenarios**'), spec.indexOf('## Build plan'));
  const expected = new Map<string, { criteria: string[]; runner: string; script: string; file: string }>();
  let previous: { runner: string; script: string; file: string } | undefined;
  for (const line of section.split('\n')) {
    const id = /^\d+\. `(BKP-\d{3})`/.exec(line)?.[1];
    if (id === undefined) continue;
    const named = /^\d+\. `BKP-\d{3}` \(`([^`]+)`, `([^`]+)`, `([^`]+)`\)/.exec(line);
    const check = named === null ? previous : { runner: named[1]!, script: named[2]!, file: named[3]! };
    if (named === null) expect(line, id).toMatch(/^\d+\. `BKP-\d{3}` \(file sama\)/);
    previous = check;
    const criteria = [...line.slice(line.lastIndexOf('Membuktikan')).matchAll(/\*\*(AC-\d+)\*\*/g)].map((match) => match[1]!);
    expect(check, id).toBeDefined();
    expect(criteria.length, id).toBeGreaterThan(0);
    expected.set(id, { criteria, ...check! });
  }
  // The sentence after the list: BKP-003 to BKP-007 write restore.json and prove AC-8 together with the gate step.
  const together = /^(BKP-\d{3}) sampai (BKP-\d{3}) menulis `restore\.json` dan membuktikan \*\*(AC-\d+)\*\*/m.exec(section);
  expect(together?.slice(1)).toEqual(['BKP-003', 'BKP-007', 'AC-8']);
  for (const id of ['BKP-003', 'BKP-004', 'BKP-005', 'BKP-006', 'BKP-007']) expected.get(id)!.criteria.push('AC-8');
  expect([...expected.keys()]).toEqual(['BKP-001', 'BKP-002', 'BKP-003', 'BKP-004', 'BKP-005', 'BKP-006', 'BKP-007', 'BKP-008']);
  // Spec 0014 (*Critical test scenarios* and row 0013 of *Amandemen spec lain*): BKP-009 joins this registry with the
  // file and script of its row there. The source of the registry stays spec 0013, so its criterion is AC-8 of spec 0013,
  // the restore evidence that BKP-009 extends with the field `sessions` of restore.json.
  const auth = await read('docs/specs/0014-akses-pengguna-lifecycle-sesi/index.md');
  const row = /^\| BKP-009 \| .+ \| `([^`]+)`, `([^`]+)` \| AC-14 \|$/m.exec(auth);
  expect(row?.slice(1)).toEqual(['tests/integration/database/backup.test.ts', 'test:database:real']);
  expected.set('BKP-009', { criteria: ['AC-8'], runner: 'bun:test', file: row![1]!, script: row![2]! });

  const registry = JSON.parse(await read('tests/scenarios/backup.json')) as Registry;
  expect(registry.source).toBe('docs/specs/0013-backup-pemulihan-data/index.md');
  expect(registry.scenarios.map((scenario) => scenario.id)).toEqual([...expected.keys()]);
  for (const scenario of registry.scenarios) {
    const want = expected.get(scenario.id)!;
    expect(scenario.criteria, scenario.id).toEqual(want.criteria);
    expect(scenario.critical, scenario.id).toBeUndefined();
    expect(scenario.checks, scenario.id).toEqual([{ runner: want.runner, file: want.file, testTag: scenario.id, script: want.script }]);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Documents (*Dokumen yang diperbarui*, *Runbook restore*, *Prosedur insiden*, *Hook fitur 15*, AC-1 and AC-9).

/**
 * *Dokumen yang diperbarui*: the strings each document must hold literally, written here from the table, with the
 * amendment of spec 0014 (row 0013 of *Amandemen spec lain*): `tidak berlaku sampai fitur 15` left the list of
 * docs/rules/backup.md, whose hook strings of spec 0014 are checked by procedureProblems below.
 */
const DOCUMENT_STRINGS: Readonly<Record<string, readonly string[]>> = {
  'docs/rules/backup.md': [
    'RPO', '24 jam', '25 jam', 'RTO', '4 jam', '35 hari', '7 backup', '26 jam', '27 jam', '30 hari', 'foundation_backup',
    'pg_read_all_data', 'pg_authid', 'openssl rand -hex 24', 'install -d -m 0700', 'chmod 0600',
    '--profile backup run --rm backup create scheduled', '--profile backup run --rm backup check',
    '--profile restore run --rm -e FOUNDATION_ADMIN_DATABASE_URL restore', 'database/fingerprint.ts', 'pre-migration',
    'common.schema_migrations', '0700', 'di luar host', 'tidak mengunggah', 'bukan keaslian', 'Backup created:',
    'ALTER ROLE', 'restore-drill-template.md', 'Migration history drift', '/dev/tcp',
  ],
  'docs/rules/deployment.md': ['-e FOUNDATION_BACKUP_PASSWORD', 'create pre-migration', 'docs/rules/backup.md'],
  'docs/rules/security.md': ['docs/rules/backup.md', 'foundation_backup', 'pg_authid'],
  'docs/rules/database.md': ['foundation_backup', 'pg_read_all_data', 'row_security'],
  'docs/rules/testing.md': ['tests/scenarios/backup.json', '.local/feature-14/restore.json', 'docker network rm'],
  'docs/rules/infrastructure.md': ['deploy/backup.yaml'],
  'docs/testing/release-report-template.md': ['Backup dan pemulihan', '.local/feature-14/restore.json', 'restore-drills'],
  'README.md': ['docs/rules/backup.md'],
};

/** The rows of the *Dokumen yang diperbarui* table of the spec: each file with the code spans of its second column. */
function specDocumentStrings(spec: string): Record<string, string[]> {
  const start = spec.indexOf('**Dokumen yang diperbarui**');
  const table = spec.slice(start, spec.indexOf('\n\n', spec.indexOf('| --- |', start)));
  const rows: Record<string, string[]> = {};
  for (const line of table.split('\n')) {
    const cells = /^\| `([^`]+)` \| (.+) \|$/.exec(line);
    if (cells !== null) rows[cells[1]!] = [...cells[2]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
  }
  return rows;
}

/** Every required string missing from `texts` (path to content), as `<path>: <string>`. */
function documentProblems(texts: Readonly<Record<string, string>>): string[] {
  const missing: string[] = [];
  for (const [path, strings] of Object.entries(DOCUMENT_STRINGS)) {
    const text = texts[path] ?? '';
    for (const value of strings) if (!text.includes(value)) missing.push(`${path}: ${value}`);
  }
  return missing;
}

/** The table of spec 0013 with the amendment of spec 0014 applied, when spec 0014 states it. */
function amendedDocumentStrings(spec: string, amendment: string): Record<string, string[]> {
  const rows = specDocumentStrings(spec);
  if (amendment.includes('string `tidak berlaku sampai fitur 15` keluar dari daftar')) {
    rows['docs/rules/backup.md'] = (rows['docs/rules/backup.md'] ?? []).filter((value) => value !== 'tidak berlaku sampai fitur 15');
  }
  return rows;
}

test('BKP-001 the documents of Dokumen yang diperbarui hold every required string literally', async () => {
  // The table here equals the table of the spec with its amendment, so neither can drift without this test failing.
  const spec = await read('docs/specs/0013-backup-pemulihan-data/index.md');
  const amendment = await read('docs/specs/0014-akses-pengguna-lifecycle-sesi/index.md');
  expect(amendedDocumentStrings(spec, amendment)).toEqual(DOCUMENT_STRINGS as Record<string, string[]>);
  expect(specDocumentStrings(spec)['docs/rules/backup.md']).toContain('tidak berlaku sampai fitur 15');
  const texts: Record<string, string> = {};
  for (const path of Object.keys(DOCUMENT_STRINGS)) texts[path] = await read(path);
  expect(documentProblems(texts)).toEqual([]);
  // A dropped string is named with its file.
  const backup = texts['docs/rules/backup.md']!;
  expect(documentProblems({ ...texts, 'docs/rules/backup.md': backup.replaceAll('bukan keaslian', 'bukan bukti') })).toEqual(['docs/rules/backup.md: bukan keaslian']);
  expect(documentProblems({ ...texts, 'README.md': '' })).toEqual(['README.md: docs/rules/backup.md']);
});

/** The lines of the `## <heading>` section of `text`, up to the next `## ` heading. */
function section(text: string, heading: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** The incidents of *Prosedur insiden*, in table order. */
const INCIDENTS = ['Kehilangan atau kerusakan data', 'Credential bocor atau dicurigai', 'Backup bocor', 'Backup gagal atau `check` gagal'];

/**
 * docs/rules/backup.md holds the ten steps of *Runbook restore* in order, the four incidents of *Prosedur insiden*, and
 * the five items of *Hook fitur 15* (AC-9). Spec 0014 (row `docs/rules/backup.md` of *Dokumen yang diperbarui*) filled
 * the hook: step 8 starts with its fixed line and a command block with `revoke-sessions --all --apply` and the output
 * `Sessions revoked:` before the backend of step 9, the first three incidents carry their session and reset strings, the
 * hook section ends with its fixed closing line, and `tidak berlaku sampai fitur 15` is gone from the file.
 * docs/rules/deployment.md passes `-e FOUNDATION_BACKUP_PASSWORD` on the provisioning command and creates the
 * `pre-migration` backup before the migration command.
 */
function procedureProblems(backup: string, deployment: string): string[] {
  const problems: string[] = [];
  const steps = section(backup, 'Runbook restore').filter((line) => /^\d+\. /.test(line));
  if (JSON.stringify(steps.map((line) => Number.parseInt(line, 10))) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])) problems.push('runbook steps');
  if (steps[7] !== '8. Cabut seluruh sesi sebelum backend berjalan (*Hook fitur 15*):') problems.push('runbook step 8');
  const runbook = section(backup, 'Runbook restore').join('\n');
  const stepEight = runbook.slice(runbook.indexOf('\n8. '), runbook.indexOf('\n9. '));
  if (!/```sh\n.*--profile migrate run --rm migrate database\/accounts\.ts revoke-sessions --all --apply\n *```/.test(stepEight)) problems.push('runbook step 8 command');
  if (!stepEight.includes('`Sessions revoked:')) problems.push('runbook step 8 output');
  const order = [
    'up -d --wait postgres',
    'migrate database/provision.ts --apply',
    '--profile restore run --rm -e FOUNDATION_ADMIN_DATABASE_URL restore <nama>.dump',
    'migrate database/migrate.ts --apply',
    '--profile migrate run --rm -e FOUNDATION_BACKUP_DATABASE_URL migrate database/fingerprint.ts',
    '--profile migrate run --rm migrate database/accounts.ts revoke-sessions --all --apply',
    'up -d --wait backend',
    `--entrypoint bash backup -c 'timeout 3 bash -c "exec 3<>/dev/tcp/1.1.1.1/443"'`,
    'down --volumes',
  ].map((value) => runbook.indexOf(value));
  if (order.some((index) => index < 0) || order.some((index, position) => position > 0 && index <= order[position - 1]!)) problems.push('runbook commands');
  const incidents = section(backup, 'Prosedur insiden').filter((line) => line.startsWith('| ') && !line.startsWith('| Insiden') && !line.startsWith('| ---'));
  if (JSON.stringify(incidents.map((line) => line.slice(2, line.indexOf(' | ')))) !== JSON.stringify(INCIDENTS)) problems.push('incidents');
  if (!incidents[0]?.includes('Cabut seluruh sesi lewat langkah 8 *Runbook restore*')) problems.push('incident 1 sessions');
  if (!incidents[1]?.includes('cabut seluruh sesi dengan backend berhenti')) problems.push('incident 2 sessions');
  if (!incidents[2]?.includes('`SELECT email FROM users.users ORDER BY email`') || !incidents[2]?.includes('set-password')) problems.push('incident 3 reset');
  const hook = section(backup, 'Hook fitur 15');
  if (hook.filter((line) => /^\d+\. /.test(line)).length !== 5) problems.push('hook items');
  if (hook.filter((line) => line.trim() !== '').at(-1) !== 'Kontrak ini terisi oleh spec 0014 (tabel *Keputusan hook backup*).') problems.push('hook closing');
  if (backup.includes('tidak berlaku sampai fitur 15')) problems.push('hook placeholder');
  const deploy = section(deployment, 'Langkah deployment berurutan').join('\n');
  const provision = /docker compose --env-file \.env\.deploy -f deploy\/compose\.yaml --profile migrate run --rm \\\n {5}(-e [A-Z_]+ ?)+\\\n {5}migrate database\/provision\.ts --apply/.exec(deploy)?.[0] ?? '';
  for (const name of ['FOUNDATION_ADMIN_DATABASE_URL', 'FOUNDATION_MIGRATOR_PASSWORD', 'FOUNDATION_BACKEND_PASSWORD', 'FOUNDATION_BACKUP_PASSWORD']) {
    if (!provision.includes(`-e ${name}`)) problems.push(`provisioning ${name}`);
  }
  const preMigration = deploy.indexOf('--profile backup run --rm backup create pre-migration');
  const migration = deploy.indexOf('--profile migrate run --rm migrate database/migrate.ts --apply');
  if (preMigration < 0 || migration < 0 || preMigration > migration) problems.push('pre-migration before migration');
  return problems;
}

test('BKP-001 the runbook holds ten steps in order, the incident procedure four incidents, the hook five items, and deployment provisions the backup role and backs up before migration', async () => {
  const backup = await read('docs/rules/backup.md');
  const deployment = await read('docs/rules/deployment.md');
  expect(procedureProblems(backup, deployment)).toEqual([]);
  // Mutations each check names.
  expect(procedureProblems(backup.replace('8. Cabut seluruh sesi sebelum backend berjalan', '8. Cabut seluruh sesi lewat backend'), deployment)).toContain('runbook step 8');
  expect(procedureProblems(backup.replace('migrate database/accounts.ts revoke-sessions --all --apply\n', 'migrate database/accounts.ts revoke-sessions --all\n'), deployment)).toContain('runbook step 8 command');
  expect(procedureProblems(backup.replaceAll('`Sessions revoked: ', '`Revoked: '), deployment)).toContain('runbook step 8 output');
  expect(procedureProblems(backup.replace('Cabut seluruh sesi lewat langkah 8 *Runbook restore*', 'Cabut seluruh sesi'), deployment)).toContain('incident 1 sessions');
  expect(procedureProblems(backup.replace('cabut seluruh sesi dengan backend berhenti', 'cabut seluruh sesi'), deployment)).toContain('incident 2 sessions');
  expect(procedureProblems(backup.replace('`SELECT email FROM users.users ORDER BY email`', '`SELECT email FROM users.users`'), deployment)).toContain('incident 3 reset');
  expect(procedureProblems(backup.replace('Kontrak ini terisi oleh spec 0014 (tabel *Keputusan hook backup*).', 'Kontrak ini terisi.'), deployment)).toContain('hook closing');
  expect(procedureProblems(`${backup}\nLangkah ini tidak berlaku sampai fitur 15.\n`, deployment)).toContain('hook placeholder');
  expect(procedureProblems(backup.replace('| Backup bocor |', '| Arsip bocor |'), deployment)).toContain('incidents');
  expect(procedureProblems(backup, deployment.replace(' -e FOUNDATION_BACKUP_PASSWORD \\', ' \\'))).toContain('provisioning FOUNDATION_BACKUP_PASSWORD');
  expect(procedureProblems(backup, deployment.replace('backup create pre-migration', 'backup create manual'))).toContain('pre-migration before migration');
});

/** The fixed headings of *Template latihan restore*, in order. */
const DRILL_HEADINGS = ['## Identitas', '## Backup yang dipulihkan', '## Langkah dan waktu', '## Hasil verifikasi', '## RPO dan RTO terukur', '## Pembersihan', '## Temuan dan tindak lanjut'];

/** The `## ` headings of `text` equal DRILL_HEADINGS, and *Langkah dan waktu* has one row per runbook step 1 to 10. */
function drillShapeProblems(text: string): string[] {
  const problems: string[] = [];
  if (JSON.stringify(text.split('\n').filter((line) => line.startsWith('## '))) !== JSON.stringify(DRILL_HEADINGS)) problems.push('headings');
  const rows = section(text, 'Langkah dan waktu').filter((line) => /^\| \d+\. /.test(line)).map((line) => Number.parseInt(line.slice(2), 10));
  if (JSON.stringify(rows) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])) problems.push('steps');
  return problems;
}

/**
 * A drill record follows the template, names the commit, the build input tree, and four image IDs, and holds no DSN and
 * no value in the form of a role password (`openssl rand -hex 24`, 48 lower case hexadecimal characters).
 */
function drillRecordProblems(text: string): string[] {
  const problems = drillShapeProblems(text);
  if (/postgres(ql)?:\/\//.test(text)) problems.push('DSN');
  if (/(^|[^0-9a-f])[0-9a-f]{48}([^0-9a-f]|$)/m.test(text)) problems.push('password');
  const identity = section(text, 'Identitas').join('\n');
  if (!/(^|[^0-9a-f])[0-9a-f]{40}([^0-9a-f]|$)/m.test(identity)) problems.push('commit');
  if (!/(^|[^0-9a-f:])[0-9a-f]{64}([^0-9a-f]|$)/m.test(identity)) problems.push('build input tree');
  if (new Set(identity.match(/sha256:[0-9a-f]{64}/g) ?? []).size !== 4) problems.push('image IDs');
  return problems;
}

test('BKP-001 the restore drill template holds the fixed headings, and every drill record follows it without a DSN or password', async () => {
  const template = await read('docs/testing/restore-drill-template.md');
  expect(drillShapeProblems(template)).toEqual([]);
  const records = (await readdir(join(root, 'docs/testing/restore-drills'))).sort();
  // The first record is the drill on the local reference topology (AC-9); every file is a dated record.
  expect(records.filter((name) => /^\d{4}-\d{2}-\d{2}-topologi-rujukan-lokal\.md$/.test(name)).length).toBeGreaterThan(0);
  for (const name of records) {
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*\.md$/);
    expect(drillRecordProblems(await read(`docs/testing/restore-drills/${name}`)), name).toEqual([]);
  }
  // Mutations each check names, on the first record.
  const record = await read(`docs/testing/restore-drills/${records[0]!}`);
  expect(drillRecordProblems(record.replace('## Pembersihan', '## Bersih bersih'))).toContain('headings');
  expect(drillRecordProblems(`${record}\npostgres://foundation_backup:x@postgres:5432/foundation\n`)).toContain('DSN');
  expect(drillRecordProblems(`${record}\nPassword: ${'ab'.repeat(24)}\n`)).toContain('password');
  expect(drillShapeProblems(template.replace('| 10. ', '| 11. '))).toContain('steps');
});
