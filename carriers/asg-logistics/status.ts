import type { Stage } from '../../core/status/index.js';

const delivered = /^Delivered(?: [A-Z0-9]{2,12})? \d+\/\d+ PCS$/i;
const departure = /^Depart ASGL at: \d{1,2}:\d{2} \d{1,2}-[a-z]{3}$/i;
const location = /^Location: [A-Z0-9]{2,12}$/i;

export function movementSummary(raw: string): { description: string; stage?: Stage } | undefined {
  const lines = raw.split(/\r?\n/).map(line => line.trim());
  const handover = lines.find(line => delivered.test(line));
  if (handover) return { description: handover, stage: 'delivered' };
  const dispatch = lines.find(line => departure.test(line));
  if (dispatch) return { description: dispatch, stage: 'in_transit' };
  const site = lines.find(line => location.test(line));
  if (site) return { description: site };
  return undefined;
}
