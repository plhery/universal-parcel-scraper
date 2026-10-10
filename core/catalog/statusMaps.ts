/**
 * The carriers' status maps, asked about one scan at a time.
 *
 * The parcel app keeps the wording no carrier map staged for review, keyed by
 * carrier, provider code and normalized wording. `statusMapAnswer` tells it
 * what the map of the scraper it runs says about such a key: the stage the map
 * gives it, a gap the map leaves on purpose, or nothing. A carrier declares its
 * `statusMap` next to its map in `status.ts`; carriers without one answer
 * `unknown`. The scans the app files under the carrier `unknown` come from the
 * universal providers, whose map is the reading they give a scan
 * (`providers/status.ts`).
 */
import { statusMap as aliexpress } from '../../carriers/aliexpress/status.js';
import { statusMap as anPost } from '../../carriers/an-post/status.js';
import { statusMap as chinaPost } from '../../carriers/china-post/status.js';
import { statusMap as chronopost } from '../../carriers/chronopost/status.js';
import { statusMap as correosSpain } from '../../carriers/correos-spain/status.js';
import { statusMap as dhlExpress } from '../../carriers/dhl-express/status.js';
import { statusMap as dpd } from '../../carriers/dpd/status.js';
import { statusMap as dpdDe } from '../../carriers/dpd-de/status.js';
import { statusMap as dpdFr } from '../../carriers/dpd-fr/status.js';
import { statusMap as dpdPl } from '../../carriers/dpd-pl/status.js';
import { statusMap as emile } from '../../carriers/emile/status.js';
import { statusMap as gofoFr } from '../../carriers/gofo-fr/status.js';
import { statusMap as gofoIt } from '../../carriers/gofo-it/status.js';
import { statusMap as jAndT } from '../../carriers/j-and-t/status.js';
import { statusMap as jntCargo } from '../../carriers/j-and-t-cargo/status.js';
import { statusMap as laPoste } from '../../carriers/la-poste/status.js';
import { statusMap as oldDominion } from '../../carriers/old-dominion/status.js';
import { statusMap as omgo } from '../../carriers/omgo/status.js';
import { statusMap as postlogistics } from '../../carriers/postlogistics/status.js';
import { statusMap as sagawa } from '../../carriers/sagawa/status.js';
import { statusMap as speedx } from '../../carriers/speedx/status.js';
import { statusMap as sto } from '../../carriers/sto/status.js';
import { statusMap as swissPost } from '../../carriers/swiss-post/status.js';
import { statusMap as thailandPost } from '../../carriers/thailand-post/status.js';
import { statusMap as tnt } from '../../carriers/tnt/status.js';
import { statusMap as ups } from '../../carriers/ups/status.js';
import { statusMap as yunexpress } from '../../carriers/yunexpress/status.js';
import type { CarrierId, Stage } from '../../generated/catalog.js';
import { statusMap as universal } from '../../providers/status.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../status/statusMap.js';
import { CARRIER_DEFINITIONS } from './definitions.js';

/** By adapter: a carrier served by another's adapter, as Delivengo by La Poste's, reads that map. */
export const STATUS_MAPS: Readonly<Record<string, CarrierStatusMap>> = {
  aliexpress, 'an-post': anPost, 'china-post': chinaPost, chronopost, 'correos-spain': correosSpain, 'dhl-express': dhlExpress,
  dpd, 'dpd-de': dpdDe, 'dpd-fr': dpdFr, 'dpd-pl': dpdPl, emile, 'gofo-fr': gofoFr, 'gofo-it': gofoIt,
  'j-and-t': jAndT, 'j-and-t-cargo': jntCargo, 'la-poste': laPoste, 'old-dominion': oldDominion, omgo,
  postlogistics, sagawa, speedx, sto, 'swiss-post': swissPost, 'thailand-post': thailandPost, tnt, ups, yunexpress,
};

/** The carrier the app files the universal providers' scans under. */
const UNIVERSAL_CARRIER = 'unknown';

/** One scan as the app observed it. */
export interface ObservedStatus {
  /**
   * The catalog carrier that served the scan, the prefix of the app's provider
   * event id: `unknown` for a scan a universal provider relayed.
   */
  readonly carrier: string;
  readonly providerCode?: string | null;
  /** The scan's wording, as the carrier sent it or already normalized. */
  readonly description: string;
}

/**
 * What the carrier's map says about a scan: it gives the scan a stage, it
 * leaves it without one on purpose, or it does not know it.
 */
export type StatusMapAnswer =
  | { readonly kind: 'mapped'; readonly stage: Stage }
  | { readonly kind: 'intentional_gap'; readonly note: string }
  | { readonly kind: 'unknown' };

const UNKNOWN: StatusMapAnswer = { kind: 'unknown' };

function carrierStatusMap(carrier: string): CarrierStatusMap | undefined {
  if (carrier === UNIVERSAL_CARRIER) return universal;
  const adapter = Object.hasOwn(CARRIER_DEFINITIONS, carrier)
    ? CARRIER_DEFINITIONS[carrier as CarrierId].tracking.adapter
    : null;
  return adapter && Object.hasOwn(STATUS_MAPS, adapter) ? STATUS_MAPS[adapter] : undefined;
}

/**
 * What the carrier's map says about one observed scan, keyed as the app keys
 * its observations: carrier, provider code and `normalizeStatusWording`
 * wording. A gap without a code covers only wording that came without one; a
 * gap without wording covers every wording of its code. A scan a universal
 * provider relayed is `mapped` with the stage the providers' reading gives it,
 * as the sync does, and `unknown` when neither its code nor a rule stages it.
 */
export function statusMapAnswer(observed: ObservedStatus): StatusMapAnswer {
  const map = carrierStatusMap(observed.carrier);
  const wording = normalizeStatusWording(observed.description);
  if (!map || !wording) return UNKNOWN;
  const code = observed.providerCode || null;
  const stage = map.stage(code, wording);
  if (stage) return { kind: 'mapped', stage };
  const key = code === null ? null : map.codeKey?.(code) ?? code;
  const gap = map.gaps.find((candidate) => (candidate.code ?? null) === key
    && (candidate.wording === undefined || candidate.wording === wording));
  return gap ? { kind: 'intentional_gap', note: gap.note } : UNKNOWN;
}
