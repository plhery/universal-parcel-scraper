/**
 * Adapters' pauses and pacing live in the process: a direct step's rest after a check only a
 * browser passes, USPS's outage pause, Correios's read window, the numbers Cainiao had no record
 * of. A host that restarts often forgets them and asks again what they held off. A long-lived host
 * can hand `keepAdapterHolds` a store: each hold is saved as it starts, and the holds still running
 * are taken up again at start.
 */

/** One adapter's pause or pacing state, which ends at `until` (epoch milliseconds). */
export interface AdapterHold {
  /** The hold's kind, a slash, and what it holds within the kind. Never a secret, a URL or a tracking number. */
  key: string;
  until: number;
  /** What the hold keeps besides its end, as JSON; absent when its end is all. */
  value?: unknown;
}

/** Where a long-lived host keeps adapters' holds across restarts. */
export interface AdapterHoldStore {
  /** The holds saved whose `until` has not passed, in any order. */
  load(): Promise<readonly AdapterHold[]>;
  /** Saves a hold, replacing what was saved under its key. The adapters carry on when it fails. */
  save(hold: AdapterHold): Promise<void>;
}

type Restore = (key: string, until: number, value: unknown) => void;

const kinds = new Map<string, Restore>();
/** Holds taken up before their kind's module registered, by kind. */
const waiting = new Map<string, AdapterHold[]>();
let store: AdapterHoldStore | null = null;

/** A kind of hold: its module saves each one through it, and puts saved ones back in place. */
export class HoldKind {
  constructor(readonly kind: string, restore: Restore) {
    if (!/^[a-z][a-z0-9-]*$/.test(kind)) throw new TypeError(`Invalid hold kind ${kind}`);
    kinds.set(kind, restore);
    const held = waiting.get(kind);
    waiting.delete(kind);
    for (const hold of held ?? []) take(restore, hold);
  }

  /** Saves a hold that ends at `until`, when the host keeps holds. */
  save(key: string, until: number, value?: unknown): void {
    const saving = store;
    if (!saving || !Number.isFinite(until)) return;
    try {
      void saving.save({ key: `${this.kind}/${key}`, until, ...(value === undefined ? {} : { value }) }).catch(() => undefined);
    } catch { /* The host's store is its own to log; the hold stays in the process. */ }
  }
}

function take(restore: Restore, hold: AdapterHold): void {
  try { restore(hold.key.slice(hold.key.indexOf('/') + 1), hold.until, hold.value); }
  catch { /* A saved hold this version cannot read is left out. */ }
}

/**
 * Keeps adapters' holds in `store` from now on, and takes up the saved ones still running; the
 * number taken up. A rejection is the store's load failing: new holds are still saved.
 */
export async function keepAdapterHolds(next: AdapterHoldStore): Promise<number> {
  store = next;
  const holds = await next.load();
  const now = Date.now();
  let taken = 0;
  for (const hold of holds) {
    if (typeof hold?.key !== 'string' || typeof hold.until !== 'number' || !(hold.until > now)) continue;
    const kind = hold.key.slice(0, Math.max(0, hold.key.indexOf('/')));
    const restore = kinds.get(kind);
    if (restore) take(restore, hold);
    else if (kind) waiting.set(kind, [...waiting.get(kind) ?? [], hold]);
    else continue;
    taken += 1;
  }
  return taken;
}

/** A short tag that tells services apart in a hold's key without saving their address. */
export function serviceTag(address: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < address.length; index += 1) hash = Math.imul(hash ^ address.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(36);
}

/** Forgets the store and every hold waiting for its kind; for tests. */
export function resetAdapterHolds(): void {
  store = null;
  waiting.clear();
}
