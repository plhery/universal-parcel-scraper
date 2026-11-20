import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = new Map(statuses.entries.map(row => [normalizeStatusWording(row.wording), row.stage as Stage]));
export const RELAYED_DELAY = 'We are informing you that you may experience delays with our service in delivering your parcel.';

export function tdgWording(description: string, original: unknown): string {
  const wording = description.replace(/\s+/g, ' ').trim();
  // The relay's generic issue/attempt template must not invent an attempt from this delay.
  if (normalizeStatusWording(wording) === 'delivery issue' && original === RELAYED_DELAY) return RELAYED_DELAY;
  return wording;
}

export function tdgStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = { stage: (_code, wording) => tdgStage(wording), gaps: [{
  wording: normalizeStatusWording('Delivery Issue'),
  note: 'This relay bucket needs its original carrier reason; its generic template does not prove a failed delivery attempt.',
}] };
