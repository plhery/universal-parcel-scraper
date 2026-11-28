import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
const STAGES: Readonly<Record<string, Stage>> = {
  // 110, 172 and 210 are worded "Em transferencia" like 50 and 90. 110 came between them and 172 after a 50; 210 came
  // hours to a day before the collection scan, 10, so J&T did not have the parcel yet: a record of the shipment, as
  // transit once a scan moved it.
  '10': 'accepted', '50': 'in_transit', '90': 'in_transit', '92': 'in_transit', '110': 'in_transit', '172': 'in_transit', '210': 'registered',
  '94': 'out_for_delivery', '100': 'delivered',
};
export const jAndTBrStage = (code: string): Stage | undefined => STAGES[code];
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['retirou a encomenda', 'accepted'], ['Chegada da encomenda expressa', 'in_transit'],
  ['Saída da encomenda expressa', 'in_transit'], ['enviando a encomenda', 'out_for_delivery'],
].map(([wording, stage]) => [normalizeStatusWording(wording!), stage as Stage]));
/**
 * The tracking page's lines the parser keeps, without their bracketed city, centres and agency. Any other line, which
 * could name a recipient or a signer, gives way to J&T's status.
 */
const PAGE_LINES = new Set(['Seu entregador retirou a encomenda', 'Chegada da encomenda expressa', 'Saída da encomenda expressa',
  'Saída da encomenda expressa enviada para', 'O entregador está enviando a encomenda'].map(normalizeStatusWording));
export const isJAndTBrPageLine = (text: string): boolean => PAGE_LINES.has(normalizeStatusWording(text.replace(/\[[^\]]*\]/g, ' ')));
/**
 * The tracking page's line words a scan around its centres, in brackets: "[CD A] Seu entregador retirou a encomenda",
 * "Saída da encomenda expressa [CD A] enviada para [CD B]". Without the brackets it opens or ends with J&T's words.
 */
function wordingStage(wording: string): Stage | undefined {
  const text = normalizeStatusWording(wording.replace(/\[[^\]]*\]/g, ' '));
  for (const [words, stage] of WORDINGS) if (text === words || text.startsWith(`${words} `) || text.endsWith(` ${words}`)) return stage;
  return undefined;
}
export const statusMap: CarrierStatusMap = { stage: (code, wording) =>
  (code === null ? undefined : jAndTBrStage(code)) ?? wordingStage(wording), gaps: [] };
