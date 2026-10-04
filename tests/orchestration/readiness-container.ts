// Container guard of the readiness harness (spec 0006, rows *Nama dan penjaga container*, *Label saat container
// dibuat*, *Pemeriksaan image sebelum `docker run`*, and *Modul penjaga container*; rationale decisions 42 to 46).
// Pure functions only, with no Bun, Node, or Docker import, so bun:test, the Bun orchestration in this folder, and
// Playwright specs running on Node share one copy of the rule. Callers run Docker themselves, with an argument array,
// and pass the JSON.parse result of `docker container inspect` or
// `docker image inspect --format '{{json .Config.Labels}}'` to these functions.
// It lives in tests/orchestration/, never in scripts/ (rationale, decision 58).

/** `'database'` is READY-008 (`bun:test`), `'browser'` is READY-009 (orchestration and Playwright). */
export type ReadinessContainerOwner = 'database' | 'browser';

/** Name pattern of each owner; the 8 hex digits come from `randomBytes(4)`. */
export const READINESS_CONTAINER_NAME: Readonly<Record<ReadinessContainerOwner, RegExp>> = Object.freeze({
  database: /^foundation-readiness-db-[0-9a-f]{8}$/,
  browser: /^foundation-readiness-[0-9a-f]{8}$/,
});

/**
 * Label arguments of every `docker run` that creates a readiness container. The two empty labels override the Compose
 * project and service a container inherits from an image built by Compose, so the `docker ps --filter
 * label=com.docker.compose.project=<name>` filters of the infrastructure suite never count a harness container.
 */
export const READINESS_RUN_LABEL_ARGS: readonly string[] = Object.freeze([
  '--label', 'foundation.test=readiness',
  '--label', 'com.docker.compose.project=',
  '--label', 'com.docker.compose.service=',
]);

/**
 * Keys Compose sets only on the containers it creates (observed on Compose 5.4.0, 5.5.0, and 5.5.1). All three are
 * checked because a one off `docker compose run` container carries no `container-number`. The project, service,
 * version, and OCI labels an image passes on are not judged: every image built by Compose carries them.
 */
export const COMPOSE_CONTAINER_LABELS: readonly string[] = Object.freeze([
  'com.docker.compose.oneoff',
  'com.docker.compose.config-hash',
  'com.docker.compose.container-number',
]);

type Labels = Record<string, unknown>;

const isLabels = (value: unknown): value is Labels => typeof value === 'object' && value !== null && !Array.isArray(value);
const carriesComposeContainerLabel = (labels: Labels) => COMPOSE_CONTAINER_LABELS.some((key) => Object.hasOwn(labels, key));

/** Step (1) of the guard, before Docker is called: the name matches the pattern of its owner. */
export function readinessNameAccepted(owner: ReadinessContainerOwner, name: unknown): boolean {
  return typeof name === 'string' && Object.hasOwn(READINESS_CONTAINER_NAME, owner) && READINESS_CONTAINER_NAME[owner].test(name);
}

/**
 * Step (3) of the guard, after `docker container inspect` succeeded: `foundation.test` is exactly `readiness` and
 * none of the three Compose container keys is present, whatever its value.
 */
export function readinessContainerLabelsAccepted(labels: unknown): boolean {
  return isLabels(labels) && labels['foundation.test'] === 'readiness' && !carriesComposeContainerLabel(labels);
}

/**
 * Step (2) of the guard when `docker container inspect` fails during cleanup: true only for exit code 1 together with
 * the daemon answer `No such container`, so cleanup may skip a container that `docker run` never created. Any other
 * failure (an unreachable daemon, a timeout, a signal, or empty output) is no proof that the container is gone, and
 * the caller fails with a fixed message instead (spec 0006, *Nama dan penjaga container*).
 */
export function readinessContainerMissing(code: unknown, stderr: unknown): boolean {
  return code === 1 && typeof stderr === 'string' && /(^|\n)Error( response from daemon)?: No such container: /.test(stderr);
}

/**
 * Image check before `docker run`: an image without labels (`null`) is accepted, and an image that carries one of the
 * three Compose container keys (for example a `docker commit` of a Compose container) is refused, so a container
 * created from an accepted image with `READINESS_RUN_LABEL_ARGS` always passes the guard and can always be removed.
 */
export function readinessImageLabelsAccepted(labels: unknown): boolean {
  return labels === null || (isLabels(labels) && !carriesComposeContainerLabel(labels));
}
