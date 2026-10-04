import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import {
  COMPOSE_CONTAINER_LABELS,
  READINESS_CONTAINER_NAME,
  READINESS_RUN_LABEL_ARGS,
  readinessContainerLabelsAccepted,
  readinessContainerMissing,
  readinessImageLabelsAccepted,
  readinessNameAccepted,
} from '../../orchestration/readiness-container.ts';
import { root } from './workspace';

// READY-010 (spec 0006, AC-10, container guard): the pure functions of tests/orchestration/readiness-container.ts, without
// Docker. Label objects are copied from the 2026-10-04 probes on Docker Compose 5.5.1 (rationale, *Bukti probe*);
// paths, hashes, and image ids are replaced by stand in values.

const oci = {
  'org.opencontainers.image.base.name': 'oraclelinux:10-slim@sha256:0000000000000000000000000000000000000000000000000000000000000000',
  'org.opencontainers.image.description': 'PostgreSQL 18 dari PGDG di atas Oracle Linux 10 slim',
  'org.opencontainers.image.title': 'foundation-postgres',
};
/** `docker image inspect` of foundation-postgres:18-pinned, built by the spec 0002 suite through Compose. */
const pinnedImage = {
  'com.docker.compose.project': 'foundation-infra-test-ccd098a0',
  'com.docker.compose.service': 'postgres',
  'com.docker.compose.version': '5.5.1',
  ...oci,
};
/** `docker image inspect` of foundation-postgres:18-dev, built by the root docker-compose.yml (project foundation). */
const devImage = { ...pinnedImage, 'com.docker.compose.project': 'foundation', 'org.opencontainers.image.base.name': 'oraclelinux:10-slim' };
/** A container `docker run --label foundation.test=readiness` creates from the pinned image: inherited labels plus ours. */
const harnessContainer = { ...pinnedImage, 'foundation.test': 'readiness' };
/** The same container created with READINESS_RUN_LABEL_ARGS: Compose project and service overridden with empty strings. */
const harnessContainerWithRunArgs = { ...harnessContainer, 'com.docker.compose.project': '', 'com.docker.compose.service': '' };
/** A container from the dev image, as the spec 0003 follow up of feature 2 may create one. */
const devHarnessContainer = { ...devImage, 'foundation.test': 'readiness' };
/** A service container created by `docker compose up`. */
const composeServiceContainer = {
  'com.docker.compose.config-hash': 'd655969be2a3824b385841d3366244ed25bd7fc77621c3a55223a28a2ebe556f',
  'com.docker.compose.container-number': '1',
  'com.docker.compose.depends_on': '',
  'com.docker.compose.image': 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  'com.docker.compose.oneoff': 'False',
  'com.docker.compose.project': 'foundation',
  'com.docker.compose.project.config_files': '/stand-in/foundation/docker-compose.yml',
  'com.docker.compose.project.working_dir': '/stand-in/foundation',
  'com.docker.compose.service': 'postgres',
  'com.docker.compose.version': '5.5.1',
  ...oci,
};
/** A one off container created by `docker compose run -d`: no container-number, but oneoff True and a slug. */
const composeOneOffContainer = {
  'com.docker.compose.config-hash': '694b6dcee1c02e0bc5bdf2df7326634ef0cd5308b03b192f289517d8d908e373',
  'com.docker.compose.depends_on': '',
  'com.docker.compose.image': 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  'com.docker.compose.oneoff': 'True',
  'com.docker.compose.project': 'readiness-label-probe-0c0592dc',
  'com.docker.compose.project.config_files': '/stand-in/oneoff-probe/compose.yml',
  'com.docker.compose.project.working_dir': '/stand-in/oneoff-probe',
  'com.docker.compose.service': 'postgres',
  'com.docker.compose.slug': '273096b9b72e1b2873a4535a840b7a9429a56ee3db36e7e4bd7f93932fb5e823',
  'com.docker.compose.version': '5.5.1',
  ...oci,
};
const composeKeyValues: Record<string, string> = {
  'com.docker.compose.oneoff': 'False',
  'com.docker.compose.config-hash': '3333333333333333333333333333333333333333333333333333333333333333',
  'com.docker.compose.container-number': '1',
};

test('READY-010 COMPOSE_CONTAINER_LABELS and READINESS_RUN_LABEL_ARGS hold exactly the values of spec 0006', () => {
  expect([...COMPOSE_CONTAINER_LABELS]).toEqual(['com.docker.compose.oneoff', 'com.docker.compose.config-hash', 'com.docker.compose.container-number']);
  expect(READINESS_RUN_LABEL_ARGS.join(' ')).toBe('--label foundation.test=readiness --label com.docker.compose.project= --label com.docker.compose.service=');
  expect([...READINESS_RUN_LABEL_ARGS]).toEqual(['--label', 'foundation.test=readiness', '--label', 'com.docker.compose.project=', '--label', 'com.docker.compose.service=']);
  expect(Object.isFrozen(COMPOSE_CONTAINER_LABELS) && Object.isFrozen(READINESS_RUN_LABEL_ARGS) && Object.isFrozen(READINESS_CONTAINER_NAME)).toBe(true);
  expect(Object.keys(READINESS_CONTAINER_NAME).sort()).toEqual(['browser', 'database']);
});

test('READY-010 readinessContainerLabelsAccepted refuses every container Compose created, and labels without the readiness mark', () => {
  const refused: [string, unknown][] = [
    ['a Compose service container with foundation.test=readiness added', { ...composeServiceContainer, 'foundation.test': 'readiness' }],
    ['a Compose one off container with foundation.test=readiness added', { ...composeOneOffContainer, 'foundation.test': 'readiness' }],
    ['a Compose service container as is', composeServiceContainer],
    ['labels without foundation.test', pinnedImage],
    ['foundation.test with another value', { ...harnessContainer, 'foundation.test': 'readiness-other' }],
    ['foundation.test with an empty value', { ...harnessContainer, 'foundation.test': '' }],
    ['null labels', null],
    ['labels that are not an object', ['foundation.test=readiness']],
    ['labels as text', 'foundation.test=readiness'],
    ['missing labels', undefined],
  ];
  for (const key of COMPOSE_CONTAINER_LABELS) {
    refused.push([`a valid harness label plus only ${key}`, { ...harnessContainerWithRunArgs, [key]: composeKeyValues[key] }]);
    refused.push([`a valid harness label plus only ${key} with an empty value`, { ...harnessContainer, [key]: '' }]);
  }
  for (const [name, labels] of refused) expect(readinessContainerLabelsAccepted(labels), name).toBe(false);
});

test('READY-010 readinessContainerLabelsAccepted accepts harness containers whatever project label they inherited', () => {
  const accepted: [string, unknown][] = [
    ['a docker run container from the pinned image with the inherited foundation-infra-test project', harnessContainer],
    ['the same container with project and service emptied by READINESS_RUN_LABEL_ARGS', harnessContainerWithRunArgs],
    ['a docker run container from the dev image with the inherited foundation project', devHarnessContainer],
  ];
  for (const [name, labels] of accepted) expect(readinessContainerLabelsAccepted(labels), name).toBe(true);
});

test('READY-010 readinessNameAccepted accepts only the name pattern of its owner', () => {
  expect(readinessNameAccepted('database', 'foundation-readiness-db-0a1b2c3d')).toBe(true);
  expect(readinessNameAccepted('browser', 'foundation-readiness-0a1b2c3d')).toBe(true);
  const refused: [Parameters<typeof readinessNameAccepted>[0], unknown][] = [
    ['database', 'foundation-readiness-0a1b2c3d'],
    ['browser', 'foundation-readiness-db-0a1b2c3d'],
    ['database', 'foundation-postgres-1'],
    ['browser', 'foundation-postgres-1'],
    ['database', 'foundation-readiness-db-0A1B2C3D'],
    ['browser', 'foundation-readiness-0A1B2C3D'],
    ['database', 'foundation-readiness-db-0a1b2c3'],
    ['database', 'foundation-readiness-db-0a1b2c3d4'],
    ['browser', 'foundation-readiness-0a1b2c3'],
    ['browser', 'foundation-readiness-0a1b2c3d4'],
    ['database', 'x-foundation-readiness-db-0a1b2c3d'],
    ['database', 'foundation-readiness-db-0a1b2c3d-1'],
    ['browser', '/foundation-readiness-0a1b2c3d'],
    ['browser', 'foundation-readiness-0a1b2c3d\n'],
    ['browser', ''],
    ['browser', undefined],
  ];
  for (const [owner, name] of refused) expect(readinessNameAccepted(owner, name), `${owner} ${String(name)}`).toBe(false);
  expect(readinessNameAccepted('other' as Parameters<typeof readinessNameAccepted>[0], 'foundation-readiness-0a1b2c3d')).toBe(false);
});

test('READY-010 readinessImageLabelsAccepted accepts the pinned and dev images and null, and refuses Compose container keys', () => {
  expect(readinessImageLabelsAccepted(pinnedImage)).toBe(true);
  expect(readinessImageLabelsAccepted(devImage)).toBe(true);
  expect(readinessImageLabelsAccepted(null)).toBe(true);
  for (const key of COMPOSE_CONTAINER_LABELS) {
    expect(readinessImageLabelsAccepted({ ...pinnedImage, [key]: composeKeyValues[key] }), key).toBe(false);
  }
  // For example an image made by docker commit of a Compose container.
  expect(readinessImageLabelsAccepted(composeServiceContainer)).toBe(false);
  expect(readinessImageLabelsAccepted(['com.docker.compose.project=foundation'])).toBe(false);
  expect(readinessImageLabelsAccepted(undefined)).toBe(false);
  // An accepted image yields a container the guard accepts once READINESS_RUN_LABEL_ARGS are applied.
  for (const imageLabels of [pinnedImage, devImage]) {
    const runLabels = Object.fromEntries(READINESS_RUN_LABEL_ARGS.filter((_, index) => index % 2 === 1).map((pair) => pair.split('=') as [string, string]));
    expect(readinessContainerLabelsAccepted({ ...imageLabels, ...runLabels })).toBe(true);
  }
});

test('READY-010 the guard takes owners only from its own table and the readiness mark only as the exact text', () => {
  // An owner name that only exists on Object.prototype never selects a pattern.
  for (const owner of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    expect(readinessNameAccepted(owner as Parameters<typeof readinessNameAccepted>[0], 'foundation-readiness-0a1b2c3d'), owner).toBe(false);
  }
  // A label value that is not exactly the text readiness is refused, even when it looks the same after conversion.
  for (const value of [' readiness', 'readiness ', 'Readiness', ['readiness'], true]) {
    expect(readinessContainerLabelsAccepted({ ...harnessContainerWithRunArgs, 'foundation.test': value }), JSON.stringify(value)).toBe(false);
  }
});

test('READY-010 readinessContainerMissing accepts only the daemon answer No such container with exit code 1', () => {
  // `docker container inspect` output observed on Docker Engine 29.8.0 (2026-10-04), plus the CLI form without daemon.
  const missing = 'Error response from daemon: No such container: foundation-readiness-db-0a1b2c3d\n';
  expect(readinessContainerMissing(1, missing)).toBe(true);
  expect(readinessContainerMissing(1, `\n${missing}`)).toBe(true);
  expect(readinessContainerMissing(1, 'Error: No such container: foundation-readiness-0a1b2c3d\n')).toBe(true);
  const refused: [string, unknown, unknown][] = [
    // An unreachable daemon also exits 1, so the code alone never proves that the container is gone.
    ['an unreachable daemon', 1, '\nfailed to connect to the docker API at unix:///stand-in/docker.sock; check if the path is correct and if the daemon is running: dial unix /stand-in/docker.sock: connect: no such file or directory\n'],
    ['exit code 1 with empty output', 1, ''],
    ['a timeout or signal without an exit code', null, ''],
    ['a timeout that still printed the missing answer', null, missing],
    ['another exit code with the missing answer', 125, missing],
    ['success', 0, missing],
    ['the text only inside another message', 1, 'Error response from daemon: permission denied, No such container: x\n'],
    ['exit code as text', '1', missing],
    ['output that is not text', 1, Buffer.from(missing)],
  ];
  for (const [name, code, stderr] of refused) expect(readinessContainerMissing(code, stderr), name).toBe(false);
});

// Every file that runs Docker on a readiness container (build plan steps 1 and 4, the cleanup of
// test:database:real, and the test:tooling:real smoke of feature 2). A missing file fails the test. A file that removes a container may skip it only when Docker
// reports it missing, so it must call readinessContainerMissing.
const guardUsers: { file: string; usesRunLabelArgs: boolean; removes: boolean }[] = [
  { file: 'tests/integration/database/readiness.test.ts', usesRunLabelArgs: true, removes: true },
  { file: 'tests/orchestration/readiness-real.ts', usesRunLabelArgs: true, removes: true },
  // Removes the READY-008 container of its run when bun test was stopped before afterAll; it never runs docker run.
  { file: 'tests/orchestration/database-real.ts', usesRunLabelArgs: false, removes: true },
  // The Playwright spec only stops and starts the container the orchestration created, so it never runs docker run.
  { file: 'tests/e2e/readiness/readiness.real.e2e.spec.ts', usesRunLabelArgs: false, removes: false },
  // test:tooling:real of feature 2 (spec 0003) creates the browser owner container and removes it after the run.
  { file: 'tests/integration/tooling-real/doctor-smoke.ts', usesRunLabelArgs: true, removes: true },
];
const guardModulePath = 'tests/orchestration/readiness-container.ts';
const guardModule = join(root, guardModulePath);

/** True when one relative import of `text` resolves, from the folder of `file`, to tests/orchestration/readiness-container.ts. */
function importsGuardModule(file: string, text: string): boolean {
  return [...text.matchAll(/\bfrom '(\.{1,2}\/[^']+)';/g)].some(([, specifier]) => {
    const target = resolve(dirname(join(root, file)), specifier!);
    return relative(guardModule, target) === '' || relative(guardModule, `${target}.ts`) === '';
  });
}

test('READY-010 every guard user imports the module, and none spells out a Compose label', async () => {
  for (const { file, usesRunLabelArgs, removes } of guardUsers) {
    const source = Bun.file(join(root, file));
    expect(await source.exists(), `${file} exists`).toBe(true);
    const text = await source.text();
    expect(importsGuardModule(file, text), `${file} imports the guard module`).toBe(true);
    if (usesRunLabelArgs) expect(text, `${file} creates containers with READINESS_RUN_LABEL_ARGS`).toContain('...READINESS_RUN_LABEL_ARGS');
    if (removes) expect(text, `${file} skips a container only when Docker reports it missing`).toContain('readinessContainerMissing(');
    expect(text.includes('com.docker.compose.'), `${file} spells out a Compose label`).toBe(false);
  }
});

// Decision 58 of spec 0006: the readiness harness runs Docker, and INFRA-001 of spec 0002 keeps every file under scripts/
// free of Docker. test:infrastructure runs outside test:ci, so this check keeps the harness out of scripts/ in test:ci.
test('READY-010 the guard module and every guard user live outside scripts/, and no script imports the guard', async () => {
  for (const file of [guardModulePath, ...guardUsers.map(({ file }) => file)]) {
    expect(file.startsWith('scripts/'), `${file} lives outside scripts/`).toBe(false);
  }
  const scripts = (await readdir(join(root, 'scripts'), { recursive: true })).filter((name) => name.endsWith('.ts'));
  expect(scripts.length).toBeGreaterThan(0);
  for (const name of scripts) {
    const file = `scripts/${name}`;
    expect(importsGuardModule(file, await Bun.file(join(root, file)).text()), `${file} imports the guard module`).toBe(false);
  }
});
