import { requestIdFor, writeLogLine, type RequestLogSink } from '../../plugins/request-log';

// Log events of spec 0014 (table *Log keamanan*): one JSON `info` line per event through the same sink as the request
// line of spec 0012, so only a composition with a sink (production through index.ts) writes them. The keys are exactly
// `time`, `level`, `event` (`auth`), `requestId`, `action`, `outcome`, `userId`, `sessionId`, and `accountKey`, with
// `null` where the table says the value does not apply. A line never holds an email, a password, a cookie, a token, a
// CSRF token, or a body: `accountKey` is the first 16 hex digits of the attempt key, a SHA 256.

/** The rows of table *Log keamanan*, so a call can only name ids the table gives that action and outcome. */
export type AuthEvent =
  | { action: 'sign_in'; outcome: 'succeeded'; userId: string; sessionId: string; accountKey: string }
  | { action: 'sign_in'; outcome: 'failed' | 'limited' | 'busy'; accountKey: string }
  | { action: 'sign_out'; outcome: 'succeeded'; userId: string; sessionId: string }
  | { action: 'session_revoke'; outcome: 'succeeded'; userId: string; sessionId: string }
  | { action: 'session_revoke'; outcome: 'not_found'; userId: string }
  | { action: 'request_rejected'; outcome: 'origin' | 'csrf' };

/** `accountKey` of table *Token*: the first 16 characters of the attempt key. */
export const accountKeyOf = (attemptKey: string) => attemptKey.slice(0, 16);

/**
 * Writes one `auth` line when the composition has a sink. `requestId` comes from requestIdFor, the id the request log
 * recorded for the same request, so the request line and the `auth` line of one request always agree. A sink that
 * throws changes no answer.
 */
export function writeAuthEvent(sink: RequestLogSink | undefined, request: Request, event: AuthEvent, now: () => Date = () => new Date()): void {
  if (sink === undefined) return;
  writeLogLine(sink, 'info', JSON.stringify({
    time: now().toISOString(),
    level: 'info',
    event: 'auth',
    requestId: requestIdFor(request),
    action: event.action,
    outcome: event.outcome,
    userId: 'userId' in event ? event.userId : null,
    sessionId: 'sessionId' in event ? event.sessionId : null,
    accountKey: 'accountKey' in event ? event.accountKey : null,
  }));
}
