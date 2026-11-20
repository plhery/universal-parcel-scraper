import { RateLimitedError } from '../errors/index.js';
import { transportOf } from './transportOf.js';

/**
 * A way out to the carrier that the host offers besides its own fetcher, such as one proxy of a
 * datacenter pool. `id` labels it in messages and must hold no address or secret.
 */
export interface Egress {
  readonly id: string;
  readonly fetcher: typeof fetch;
}

/** How densely one carrier may be read from one address, and how long a refused address rests. */
export interface EgressLimit {
  /** Reads one egress sends in any `windowMs`. */
  readonly reads: number;
  readonly windowMs: number;
  /** How long an egress the carrier refused sends nothing, when the refusal names no wait. */
  readonly pauseMs: number;
}

interface EgressState { sentAt: number[]; pausedUntil: number; lastSentAt: number }
const DEFAULT_TRANSPORT = {};

/**
 * The host's fetcher first, then the egresses of the named pool. A carrier that limits each address
 * spreads its reads over them with an `EgressPacer`. The pool is empty unless the host offers it.
 */
export function egressesOf(fetcher: typeof fetch | undefined, pool: readonly Egress[] | undefined): readonly EgressChoice[] {
  return [{ id: 'default', fetcher }, ...(pool ?? [])];
}

export interface EgressChoice {
  readonly id: string;
  /** Undefined is the global fetch. */
  readonly fetcher: typeof fetch | undefined;
}

/**
 * Paces one carrier's reads per egress, for a carrier that limits each address. A read takes the first
 * egress in order with a free turn: the host's own fetcher while it has turns, then the pool's egress
 * that rested longest. When none has a turn, the read fails as our own pacing (rate_limited,
 * self_paced) with the shortest wait, and sends nothing. Every tracker of the process that uses the same
 * pacer and fetcher shares its turns; recognition included. A restart forgets them.
 */
export class EgressPacer {
  readonly #states = new WeakMap<object, EgressState>();

  constructor(private readonly provider: string, private readonly limit: EgressLimit) {
    if (!(limit.reads > 0) || !(limit.windowMs > 0) || !(limit.pauseMs >= 0)) throw new TypeError('Egress limits must be positive');
  }

  /** Takes a turn on the first egress that has one now. */
  take<T extends EgressChoice>(egresses: readonly T[], now = Date.now()): T {
    let chosen: T | undefined;
    let chosenState: EgressState | undefined;
    let shortest = Number.POSITIVE_INFINITY;
    for (const [index, egress] of egresses.entries()) {
      const state = this.#state(egress.fetcher);
      const wait = this.#waitMs(state, now);
      if (wait > 0) {
        shortest = Math.min(shortest, wait);
        continue;
      }
      // The host's own fetcher goes first; among the pool, the one that rested longest.
      if (index === 0) { chosen = egress; chosenState = state; break; }
      if (!chosenState || state.lastSentAt < chosenState.lastSentAt) { chosen = egress; chosenState = state; }
    }
    if (!chosen || !chosenState) {
      throw new RateLimitedError(this.provider, Number.isFinite(shortest) ? shortest : this.limit.pauseMs,
        `${this.provider} was read as often as its egresses allow`, { reason: 'self_paced' });
    }
    chosenState.sentAt.push(now);
    chosenState.lastSentAt = now;
    return chosen;
  }

  /** The carrier refused this egress: it rests for the `waitMs` the carrier named, else for the limit's pause. */
  refused(egress: EgressChoice, waitMs?: number, now = Date.now()): number {
    const rest = waitMs !== undefined && Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : this.limit.pauseMs;
    const state = this.#state(egress.fetcher);
    state.pausedUntil = Math.max(state.pausedUntil, now + rest);
    return rest;
  }

  /** How long until an egress of `egresses` has a turn, 0 when one has. */
  waitMs(egresses: readonly EgressChoice[], now = Date.now()): number {
    return Math.min(...egresses.map(egress => this.#waitMs(this.#state(egress.fetcher), now)));
  }

  #state(fetcher: typeof fetch | undefined): EgressState {
    const key = transportOf(fetcher) ?? DEFAULT_TRANSPORT;
    let state = this.#states.get(key);
    if (!state) this.#states.set(key, state = { sentAt: [], pausedUntil: 0, lastSentAt: 0 });
    return state;
  }

  #waitMs(state: EgressState, now: number): number {
    const sentAt = state.sentAt = state.sentAt.filter(at => now - at < this.limit.windowMs);
    const window = sentAt.length < this.limit.reads ? 0 : sentAt[sentAt.length - this.limit.reads]! + this.limit.windowMs - now;
    return Math.max(window, state.pausedUntil - now, 0);
  }
}
