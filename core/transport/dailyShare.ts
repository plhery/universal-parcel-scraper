const DAY_MS = 86_400_000;

/**
 * A daily byte share for a proxy paid by the byte, charged a fixed amount a read. It refills continuously,
 * holds at most a quarter of a day's share and starts with one read, so a restart adds almost nothing to
 * the day's traffic.
 */
export class DailyShare {
  #bytes: number;
  #at = Date.now();

  constructor(private readonly daily: number, private readonly readBytes: number) {
    this.#bytes = readBytes;
  }

  /** Whether a read fits in the share now. */
  affords(): boolean {
    if (this.daily === Infinity) return true;
    const now = Date.now();
    this.#bytes = Math.min(Math.max(this.daily / 4, this.readBytes), this.#bytes + Math.max(0, now - this.#at) * this.daily / DAY_MS);
    this.#at = now;
    return this.#bytes >= this.readBytes;
  }

  /** Charges a read when it fits; whether it did. */
  take(): boolean {
    if (!this.affords()) return false;
    if (this.daily !== Infinity) this.#bytes -= this.readBytes;
    return true;
  }
}
