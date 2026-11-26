import type { CarrierResult } from '../../core/result/index.js';
import { type DelyvaTenant, normalizeDelyvaNumber, parseDelyva } from './delyva.js';

export const PROVIDER = 'babyxpress';

/** BabyXpress's Delyva tenant, `babyxpress-my.delyva.app`, whose tracker page names this company id. */
export const BABYXPRESS: DelyvaTenant = { provider: PROVIDER, name: 'BabyXpress', companyId: 'f273c9c9-6420-42d8-84ce-a83fc3b96fde' };

/** A number for BabyXpress's tracker. */
export const normalizeBabyXpressNumber = (raw: string): string => normalizeDelyvaNumber(raw, BABYXPRESS);

/** Reads one reply of the Delyva tracking service for a BabyXpress consignment. */
export const parseBabyXpress = (payload: unknown, number: string): CarrierResult => parseDelyva(payload, number, BABYXPRESS);
