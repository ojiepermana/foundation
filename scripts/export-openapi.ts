import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './lib/canonical-json';
import { OPENAPI_MAX_BYTES, OpenApiContractError, validateOpenApi } from './validate-openapi';

// Exports the contract of the real development composition without a listener, database, or network
// (spec 0008, AC-1, AC-2, AC-6). CLI arguments are not read. Every failure prints fixed text only and
// leaves openapi.json untouched, because the file is replaced by renaming a finished temporary file.
const target = fileURLToPath(new URL('../openapi.json', import.meta.url));
let reported = false;

function fail(error: unknown): void {
  if (reported) return;
  reported = true;
  console.error(error instanceof OpenApiContractError ? `OpenAPI export failed\nrule: ${error.rule}` : 'OpenAPI export failed');
  process.exitCode = 1;
}
// These handlers end the process at once. They run only between event loop turns, and the write below is
// synchronous from the first file operation to the rename, so a handler never runs in the middle of it.
process.on('uncaughtException', error => { fail(error); process.exit(1); });
process.on('unhandledRejection', error => { fail(error); process.exit(1); });

async function exportText(): Promise<string> {
  const { createApp } = await import('../apps/backend/src/app');
  const app = createApp('development');
  await app.modules;
  // The URL only addresses the in process request; it never reaches the output.
  const response = await app.handle(new Request('http://localhost/openapi/json'));
  if (!response.ok) throw new Error('OpenAPI plugin response failed');
  const document: unknown = JSON.parse(await response.text());
  validateOpenApi(document);
  const text = canonicalJson(document);
  if (Buffer.byteLength(text) > OPENAPI_MAX_BYTES) throw new Error('OpenAPI text too large');
  return text;
}

/** Writes a temporary file next to openapi.json and renames it over the target, without yielding in between. */
function writeAtomically(text: string): void {
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: 'wx' });
    renameSync(temporary, target);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The original failure is reported; a temporary file that cannot be removed changes nothing in it.
    }
    throw error;
  }
}

try {
  const text = await exportText();
  // One timer turn first: a rejection, an exception from an immediate, or a zero delay timer left behind by the
  // composition is reported now, and its handler ends the process before any file operation.
  await new Promise(resolve => setTimeout(resolve, 0));
  writeAtomically(text);
  console.log('OpenAPI exported without listener');
} catch (error) {
  fail(error);
}
