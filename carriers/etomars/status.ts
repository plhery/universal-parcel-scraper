import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const PHASES: ReadonlyMap<string, Stage> = new Map([
  ['10', 'registered'], ['20', 'registered'], ['30', 'in_transit'], ['100', 'in_transit'],
  ['200', 'customs'], ['300', 'customs'], ['400', 'customs'], ['500', 'in_transit'], ['550', 'in_transit'],
]);

export function etomarsStage(code: string | null, wording: string): ClassifiedWording | null {
  if (!code) return null;
  // The destination phase also contains linehaul and depot storage, before a delivery round.
  const stage = code === '550' && /(?:^|[ —])配達中(?:$|[ (])/.test(wording) ? 'out_for_delivery'
    : code === '700' ? /\bdelivered\b|配達完了/i.test(wording) ? 'delivered' : undefined
      : PHASES.get(code);
  return stage ? { stage, source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => etomarsStage(code, wording)?.stage,
  gaps: [{ code: '700', wording: normalizeStatusWording('Order Completed'),
    note: 'Order completion alone does not describe the delivery outcome; the delivery activity supplies it.' }],
};
