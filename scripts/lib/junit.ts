// JUnit reader of spec 0010 (*Pembaca JUnit* and *Judul lengkap*), with no dependency. A small XML tokenizer that knows
// declarations and processing instructions, comments, CDATA, quoted attribute values that hold `>`, the five standard
// entities, and decimal and hexadecimal character references. `DOCTYPE` and every other entity are rejected. The text
// of `system-out` and `system-err` is only text, so `<testcase` or `</testsuite>` inside a Playwright attachment CDATA
// is never read as an element. Anything this reader does not recognise throws `JUnitError`, which the tier runner
// records as `evidence_invalid`; it never turns into a passing result.

/** Size limit for every text evidence file, JUnit included (spec 0010, *Bukti per langkah*). */
export const EVIDENCE_TEXT_LIMIT = 50 * 1024 * 1024;

export class JUnitError extends Error {}

export type JUnitRunner = 'bun:test' | 'vitest' | 'playwright';

export type JUnitTestcase = {
  attributes: Readonly<Record<string, string>>;
  failures: number;
  errors: number;
  skipped: boolean;
  /** The `message` attribute of `skipped`, or `null` when there is none. */
  skipMessage: string | null;
};

export type JUnitSuite = {
  attributes: Readonly<Record<string, string>>;
  suites: JUnitSuite[];
  testcases: JUnitTestcase[];
};

/** The file level suites: the children of a `testsuites` root, or a `testsuite` root by itself. */
export type JUnitDocument = { suites: JUnitSuite[] };

export type JUnitCounts = { tests: number; failures: number; errors: number; skipped: number };

export type JUnitOutcome = 'passed' | 'failed' | 'error' | 'skipped';

/** One testcase with its file level suite and its full title (spec 0010, *Judul lengkap*). */
export type JUnitResult = {
  fileSuite: Readonly<Record<string, string>>;
  title: string;
  outcome: JUnitOutcome;
  skipMessage: string | null;
};

type ElementName =
  | 'testsuites'
  | 'testsuite'
  | 'testcase'
  | 'properties'
  | 'property'
  | 'system-out'
  | 'system-err'
  | 'failure'
  | 'error'
  | 'skipped';

/** Allowed parents per element; `null` stands for the document root. */
const parents: Record<ElementName, ReadonlyArray<ElementName | null>> = {
  testsuites: [null],
  testsuite: [null, 'testsuites', 'testsuite'],
  testcase: ['testsuite'],
  properties: ['testsuites', 'testsuite', 'testcase'],
  property: ['properties'],
  'system-out': ['testsuites', 'testsuite', 'testcase'],
  'system-err': ['testsuites', 'testsuite', 'testcase'],
  failure: ['testcase'],
  error: ['testcase'],
  skipped: ['testcase'],
};

/** Elements whose content is text only; a child element inside them is invalid. */
const textOnly = new Set<ElementName>(['property', 'system-out', 'system-err', 'failure', 'error', 'skipped']);

const entities: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const namePattern = /^[A-Za-z_][-A-Za-z0-9_.:]*/;

function isElementName(name: string): name is ElementName {
  return Object.hasOwn(parents, name);
}

/** Decodes the five standard entities and numeric references; any other `&` is invalid. */
function decode(text: string): string {
  return text.replace(/&([^;&\s]*);?/g, (match, body: string) => {
    if (!match.endsWith(';')) throw new JUnitError('Bare ampersand');
    if (Object.hasOwn(entities, body)) return entities[body] as string;
    const numeric = /^#(?:([0-9]+)|x([0-9A-Fa-f]+))$/.exec(body);
    if (!numeric) throw new JUnitError('Unknown entity');
    const code = numeric[1] !== undefined ? Number.parseInt(numeric[1], 10) : Number.parseInt(numeric[2] as string, 16);
    if (!Number.isSafeInteger(code) || code < 1 || code > 0x10ffff) throw new JUnitError('Invalid character reference');
    return String.fromCodePoint(code);
  });
}

type Open = {
  name: ElementName;
  attributes: Record<string, string>;
  suite?: JUnitSuite;
  testcase?: JUnitTestcase;
};

/** Reads the attributes of one start tag body (after the name); returns them and whether the tag closes itself. */
function readAttributes(body: string): { attributes: Record<string, string>; selfClosing: boolean } {
  const attributes: Record<string, string> = {};
  let rest = body;
  let selfClosing = false;
  for (;;) {
    const trimmed = rest.replace(/^[ \t\r\n]+/, '');
    const hadSpace = trimmed.length !== rest.length;
    rest = trimmed;
    if (rest === '') break;
    if (rest === '/') {
      selfClosing = true;
      break;
    }
    if (!hadSpace) throw new JUnitError('Missing space before attribute');
    const name = namePattern.exec(rest)?.[0];
    if (name === undefined) throw new JUnitError('Invalid attribute name');
    rest = rest.slice(name.length).replace(/^[ \t\r\n]+/, '');
    if (!rest.startsWith('=')) throw new JUnitError('Attribute without value');
    rest = rest.slice(1).replace(/^[ \t\r\n]+/, '');
    const quote = rest[0];
    if (quote !== '"' && quote !== "'") throw new JUnitError('Unquoted attribute value');
    const end = rest.indexOf(quote, 1);
    if (end < 0) throw new JUnitError('Unterminated attribute value');
    const raw = rest.slice(1, end);
    if (raw.includes('<')) throw new JUnitError('Attribute value holds <');
    if (Object.hasOwn(attributes, name)) throw new JUnitError('Duplicate attribute');
    attributes[name] = decode(raw);
    rest = rest.slice(end + 1);
  }
  return { attributes, selfClosing };
}

/** Finds the `>` that ends a start tag beginning at `start`, skipping `>` inside quoted attribute values. */
function tagEnd(text: string, start: number): number {
  let quote: string | undefined;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return index;
    else if (char === '<') throw new JUnitError('Unexpected < inside a tag');
  }
  throw new JUnitError('Unterminated tag');
}

/** Parses one JUnit document; throws `JUnitError` for anything outside *Pembaca JUnit*. */
export function parseJUnit(input: string): JUnitDocument {
  if (input.length > EVIDENCE_TEXT_LIMIT) throw new JUnitError('JUnit above the size limit');
  const text = input.startsWith('﻿') ? input.slice(1) : input;
  const stack: Open[] = [];
  const document: JUnitDocument = { suites: [] };
  let rootSeen = false;
  let index = 0;

  const checkText = (chunk: string) => {
    if (stack.length === 0) {
      if (chunk.trim() !== '') throw new JUnitError('Text outside the root element');
      return;
    }
    decode(chunk);
  };

  while (index < text.length) {
    const open = text.indexOf('<', index);
    if (open < 0) {
      checkText(text.slice(index));
      break;
    }
    checkText(text.slice(index, open));

    if (text.startsWith('<?', open)) {
      const end = text.indexOf('?>', open + 2);
      if (end < 0) throw new JUnitError('Unterminated processing instruction');
      index = end + 2;
      continue;
    }
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      if (end < 0) throw new JUnitError('Unterminated comment');
      index = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      if (stack.length === 0) throw new JUnitError('CDATA outside the root element');
      const end = text.indexOf(']]>', open + 9);
      if (end < 0) throw new JUnitError('Unterminated CDATA');
      index = end + 3;
      continue;
    }
    if (text.startsWith('<!', open)) throw new JUnitError('DOCTYPE and declarations are not allowed');

    if (text.startsWith('</', open)) {
      const end = text.indexOf('>', open + 2);
      if (end < 0) throw new JUnitError('Unterminated end tag');
      const name = text.slice(open + 2, end).replace(/[ \t\r\n]+$/, '');
      const top = stack.pop();
      if (top === undefined || top.name !== name) throw new JUnitError('Mismatched end tag');
      index = end + 1;
      continue;
    }

    const end = tagEnd(text, open + 1);
    const tag = text.slice(open + 1, end);
    const name = namePattern.exec(tag)?.[0];
    if (name === undefined) throw new JUnitError('Invalid element name');
    if (!isElementName(name)) throw new JUnitError('Unknown element');
    const parent = stack.at(-1);
    if (parent === undefined && rootSeen) throw new JUnitError('Second root element');
    if (parent !== undefined && textOnly.has(parent.name)) throw new JUnitError('Element inside text only content');
    if (!parents[name].includes(parent?.name ?? null)) throw new JUnitError('Element in the wrong place');
    const { attributes, selfClosing } = readAttributes(tag.slice(name.length));
    rootSeen = true;

    const element: Open = { name, attributes };
    if (name === 'testsuite') {
      const suite: JUnitSuite = { attributes, suites: [], testcases: [] };
      element.suite = suite;
      if (parent?.suite !== undefined) parent.suite.suites.push(suite);
      else document.suites.push(suite);
    } else if (name === 'testcase') {
      const testcase: JUnitTestcase = { attributes, failures: 0, errors: 0, skipped: false, skipMessage: null };
      element.testcase = testcase;
      (parent?.suite as JUnitSuite).testcases.push(testcase);
    } else if (parent?.testcase !== undefined) {
      if (name === 'failure') parent.testcase.failures += 1;
      else if (name === 'error') parent.testcase.errors += 1;
      else if (name === 'skipped') {
        parent.testcase.skipped = true;
        const message = attributes['message'];
        if (message !== undefined && message.trim() !== '') parent.testcase.skipMessage ??= message;
      }
    }
    if (!selfClosing) stack.push(element);
    index = end + 1;

    // Text only content is skipped as a whole up to its own end tag, so markup inside CDATA is never parsed.
    if (!selfClosing && textOnly.has(name)) {
      for (;;) {
        const next = text.indexOf('<', index);
        if (next < 0) throw new JUnitError('Unterminated text element');
        checkText(text.slice(index, next));
        if (text.startsWith('<![CDATA[', next)) {
          const close = text.indexOf(']]>', next + 9);
          if (close < 0) throw new JUnitError('Unterminated CDATA');
          index = close + 3;
        } else if (text.startsWith('<!--', next)) {
          const close = text.indexOf('-->', next + 4);
          if (close < 0) throw new JUnitError('Unterminated comment');
          index = close + 3;
        } else if (text.startsWith('<?', next)) {
          const close = text.indexOf('?>', next + 2);
          if (close < 0) throw new JUnitError('Unterminated processing instruction');
          index = close + 2;
        } else {
          index = next;
          break;
        }
      }
    }
  }

  if (!rootSeen) throw new JUnitError('No root element');
  if (stack.length !== 0) throw new JUnitError('Unclosed element');
  return document;
}

function* walk(suite: JUnitSuite, inner: readonly string[], fileSuite: JUnitSuite, runner: JUnitRunner): Generator<JUnitResult> {
  for (const testcase of suite.testcases) {
    const name = testcase.attributes['name'] ?? '';
    const title = runner === 'bun:test' ? [...inner, name].join(' > ') : name;
    let outcome: JUnitOutcome = 'passed';
    if (testcase.failures > 0) outcome = 'failed';
    else if (testcase.errors > 0) outcome = 'error';
    else if (testcase.skipped) outcome = 'skipped';
    yield { fileSuite: fileSuite.attributes, title, outcome, skipMessage: testcase.skipMessage };
  }
  for (const child of suite.suites) yield* walk(child, [...inner, child.attributes['name'] ?? ''], fileSuite, runner);
}

/**
 * Every testcase with its full title: on `bun:test` the names of the suites nested under the file suite plus the
 * testcase name, joined with ` > `; on Vitest and Playwright the testcase name as it is.
 */
export function junitResults(document: JUnitDocument, runner: JUnitRunner): JUnitResult[] {
  return document.suites.flatMap((suite) => [...walk(suite, [], suite, runner)]);
}

/** Counts testcases by element, never by the summary attributes a reporter writes. */
export function junitCounts(document: JUnitDocument): JUnitCounts {
  const counts: JUnitCounts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  const visit = (suite: JUnitSuite) => {
    for (const testcase of suite.testcases) {
      counts.tests += 1;
      if (testcase.failures > 0) counts.failures += 1;
      else if (testcase.errors > 0) counts.errors += 1;
      else if (testcase.skipped) counts.skipped += 1;
    }
    for (const child of suite.suites) visit(child);
  };
  for (const suite of document.suites) visit(suite);
  return counts;
}
