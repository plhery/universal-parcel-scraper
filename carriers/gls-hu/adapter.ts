import type { CarrierResult } from '../../core/result/index.js';
import {
  GLSNationalTracker, glsNationalAdapter, glsNationalOverviewUrl, glsNationalParcelDay, normalizeGLSNationalNumber,
  parseGLSNationalOverview, type GLSNationalNetwork,
} from './national.js';

// GLS Hungary's national parcel numbers exist only under the tracking service's Hungarian path.
const HUNGARY: GLSNationalNetwork = {
  id: 'gls-hu',
  provider: 'GLS Hungary',
  country: 'HU',
  timezone: 'Europe/Budapest',
  page: 'https://gls-group.com/HU/hu/csomagkovetes/',
};

/** A GLS Hungary parcel number as its tracker takes it. */
export const normalizeGLSHungaryNumber = (raw: string): string => normalizeGLSNationalNumber(HUNGARY, raw);

/** The overview request GLS Hungary's tracking page makes, in its English locale. */
export const glsHungaryOverviewUrl = (raw: string, millis?: number): string => glsNationalOverviewUrl(HUNGARY, raw, millis);

/** The overview's row for the requested parcel: its status, as a summary in Budapest time. */
export const parseGLSHungaryOverview = (payload: unknown, raw: string): CarrierResult => parseGLSNationalOverview(HUNGARY, payload, raw);

/**
 * The day the overview gives the requested parcel: the day GLS first had its data. A parcel keeps it
 * from pre-advice to delivery, as its archived replies in numbers.json show.
 */
export const glsHungaryParcelDay = (payload: unknown, raw: string): string | null => glsNationalParcelDay(HUNGARY, payload, raw);

export class GLSHungaryTracker extends GLSNationalTracker {
  constructor(options: { fetcher?: typeof fetch; userAgent?: string; now?: () => number } = {}) {
    super(HUNGARY, options);
  }
}

export const adapter = glsNationalAdapter(HUNGARY);
