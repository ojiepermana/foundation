import { commandLine } from './runner';

if (import.meta.main) await commandLine('migration');
