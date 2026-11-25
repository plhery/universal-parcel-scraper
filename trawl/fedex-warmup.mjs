// A new FedEx retry worker prepares a verified FedEx session before it opens its port, while the worker it replaces
// still serves: FedEx usually refuses a new session, so a fresh worker's first lookups would otherwise fail.
import { fedexSessionNumber } from './fedex-session.mjs';
import { warmupPeerServing } from './warmup-peer.mjs';

const PAGE = 'https://www.fedex.com/fedextrack/';
const API = 'https://api.fedex.com/track/v2/shipments';
// At most three lookups of the worker's 40 seconds, five seconds apart. Each one spends proxy bytes.
export const FEDEX_WARMUP_MS = 150_000;
export const FEDEX_WARMUP_ATTEMPTS = 3;
const PAUSE_MS = 5_000;
// Too little time left for a lookup to reach FedEx's reply.
const MIN_LOOKUP_MS = 10_000;
const reportWarmup = fields => console.warn(JSON.stringify({ level: 'warn', event: 'fedex.warmup', ...fields }));

/** The warm-up's lookup, as the FedEx adapter asks the worker for one; null for a number the worker would refuse. */
export function fedexWarmupRequest(number) {
  const url = `${PAGE}?trknbr=${encodeURIComponent(String(number ?? '').trim())}`;
  const req = { url, skipHttp: true, maxTier: 3, maxTimeout: 40_000, captureResponses: [API] };
  return fedexSessionNumber(url, req) ? req : null;
}

/**
 * Looks `number` up through `lookup` until `verified()` says a browser holds a verified FedEx session. While another
 * worker under `peerHost` serves, resolves once the session is verified, that worker stops answering, the attempts
 * are spent or `limitMs` passed; the caller then opens its port. Alone, it resolves at once and the lookups run
 * beside the worker's own, which a busy browser refuses as usual. `lookup` answers `{ busy: true }` when every
 * browser is serving one; that lookup did not run and is not counted. It ends once `stopped()`, as at shutdown.
 */
export async function warmFedExSession({ number, lookup, verified, stopped = () => false, peerHost, port,
  peer = peerHost ? () => warmupPeerServing(peerHost, port) : async () => false, limitMs = FEDEX_WARMUP_MS,
  attempts = FEDEX_WARMUP_ATTEMPTS, pauseMs = PAUSE_MS, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), report = reportWarmup }) {
  const say = fields => { try { report(fields); } catch { /* Diagnostics never hold the port. */ } };
  const serving = async () => { try { return await peer(); } catch { return false; } };
  const ready = () => { try { return Boolean(verified()); } catch { return false; } };
  const started = now();
  const req = fedexWarmupRequest(number);
  if (!req) {
    say({ state: 'skipped', reason: 'invalid_number' });
    return { held: false, done: Promise.resolve() };
  }
  const held = await serving();
  const run = async () => {
    let tried = 0, state = 'gave_up';
    for (;;) {
      if (ready()) { state = 'ready'; break; }
      if (stopped()) { state = 'stopped'; break; }
      const left = limitMs - (now() - started);
      if (tried >= attempts || left < MIN_LOOKUP_MS) break;
      let answer;
      try { answer = await lookup({ ...req, maxTimeout: Math.min(req.maxTimeout, left) }); } catch { answer = null; }
      if (!answer?.busy) tried++;
      if (ready()) { state = 'ready'; break; }
      if (held && !await serving()) { state = 'peer_gone'; break; }
      await sleep(pauseMs);
    }
    say({ state, held, attempts: tried, ms: Math.max(0, now() - started) });
  };
  if (!held) {
    say({ state: 'not_held', reason: 'no_peer' });
    return { held: false, done: run().catch(() => {}) };
  }
  say({ state: 'started' });
  await run().catch(() => {});
  return { held: true, done: Promise.resolve() };
}
