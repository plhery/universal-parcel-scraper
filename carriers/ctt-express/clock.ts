import { PORTUGAL_LEG } from './status.js';
import cttExpressStatuses from './statuses.json' with { type: 'json' };

// CTT Express's statuses in Spain, which Chinese lines relay at a wall clock two hours after CTT Express's
// instant, to the second, whatever Madrid's offset: CTT Portugal's copies of the same scans agree with
// CTT Express's instants, not with the relayed clock read in Madrid.
const LABELS: ReadonlySet<string> = new Set([...cttExpressStatuses.entries.map(({ wording }) => wording), 'Entregado']
  .map((wording) => wording.toLowerCase()));
const CLOCK = 'UTC+2';
// On a parcel bound for Portugal, CTT Express gives CTT Portugal's steps Lisbon's wall clock under
// Madrid's offset, and the relayed copies come two hours after that instant: an hour after the scan, all year.
// Read so, they fall on CTT Portugal's own rows to the second.
const PORTUGAL_LABELS: ReadonlySet<string> = new Set([...cttExpressStatuses.entries
  .filter((entry) => 'code' in entry && PORTUGAL_LEG.has(String(entry.code))).map(({ wording }) => wording), 'Entregado']
  .map((wording) => wording.toLowerCase()));
const PORTUGAL_CLOCK = 'UTC+1';

/** The zone of CTT Express's status `label` as a Chinese line relays it, or null for another wording. */
export function cttExpressRelayZone(label: string, portugal: boolean): string | null {
  const key = label.trim().toLowerCase();
  if (!LABELS.has(key)) return null;
  return portugal && PORTUGAL_LABELS.has(key) ? PORTUGAL_CLOCK : CLOCK;
}
