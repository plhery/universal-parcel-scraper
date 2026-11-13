import type { TrawlClient } from '../transport/trawl.js';

/**
 * How long a carrier's lookups go straight to their browser step after its direct step met a check
 * only a browser passes. A few direct reads a day still ask whether the check is gone.
 */
export const DIRECT_REST_MS = 6 * 3_600_000;

/**
 * When each carrier's direct step may run again, by carrier and browser service. Every tracker in
 * the process that uses the service shares it, as a host's several registries do; a restart forgets it.
 */
const restedUntil = new Map<string, number>();

/**
 * A carrier's direct step that a check only a browser passes keeps refusing, such as a Turnstile
 * page or a gateway that refuses plain HTTP. After such a refusal the carrier's lookups skip the
 * direct step for `DIRECT_REST_MS`, then the next one asks it again. Without a browser service
 * there is nothing to skip to, and the direct step always runs.
 */
export class DirectRest {
  readonly #key: string | null;

  constructor(carrier: string, trawl: TrawlClient | null | undefined) {
    const service = trawl?.endpoint?.href;
    this.#key = service ? `${carrier} ${service}` : null;
  }

  /** Whether lookups skip the direct step now. */
  get resting(): boolean {
    return this.#key !== null && (restedUntil.get(this.#key) ?? 0) > Date.now();
  }

  /** The direct step met a check only a browser passes. */
  refused(): void {
    if (this.#key !== null) restedUntil.set(this.#key, Date.now() + DIRECT_REST_MS);
  }
}
