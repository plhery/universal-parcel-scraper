import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const key = (code: string | null, wording: string) => `${code ?? ''}\n${normalizeStatusWording(wording)}`;
const BY_ROW: ReadonlyMap<string, Stage> = new Map(statuses.entries.map(({ code, wording, stage }) => [key(code, wording), stage as Stage]));

/** The statuses a row of the form `Status--wording` opens with, which mean one stage whatever their wording. */
const BY_CODE: ReadonlyMap<string, Stage> = new Map([
  ['InfoReceived', 'registered'],
  ['OutForDelivery', 'out_for_delivery'],
  ['Delivered', 'delivered'],
] as const);

// The local agent's transfer to the agent that delivers, which names the agent's town.
const TO_AGENT = /^in transit to agent [a-z][a-z .'-]{0,40}$/;

/** The stage Austway's map gives a row by its status code and its wording. */
export function austwayMappedStage(code: string | null, wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return BY_ROW.get(key(code, normalized)) ?? (code ? BY_CODE.get(code) : TO_AGENT.test(normalized) ? 'in_transit' : undefined);
}

/** A row's stage: the map, else the shared wording rules, else nothing. */
export function austwayStage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = austwayMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = { stage: (code, wording) => austwayMappedStage(code, wording), gaps: [] };
