import { resolve } from 'node:path';
import { runApiCheck } from './lib/api-check.ts';

// `bun run api:check` (spec 0009, AC-6): a thin CLI around `runApiCheck` with a 120000 ms limit per `api:sync` run.
const syncTimeoutMs = 120_000;

process.exitCode = await runApiCheck({ root: resolve(import.meta.dir, '..'), syncTimeoutMs });
