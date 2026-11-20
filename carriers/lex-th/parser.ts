import { lexNumber, parseLexSearch, type LexTenant } from '../lex-id/lex.js';

const isThaiNetwork = (value: unknown): boolean => typeof value === 'string' && value.trim().toUpperCase() === 'LEX TH';

/** The Thai site also lists handoffs. At least one tracked leg must name the local network. */
export const LEX_TH: LexTenant = {
  carrier: 'lex-th',
  provider: 'LEX Thailand',
  origin: 'https://lex.th',
  timezone: 'Asia/Bangkok',
  asked: number => /^[A-Z0-9]{6,40}$/.test(number) ? number : null,
  shape: 'one parcel number of 6 to 40 letters and digits',
  matchesPackage: item => isThaiNetwork(item.firstMileShippingProvider) || isThaiNetwork(item.lastMileShippingProvider),
};

export const parseLexThaiSearch = (payload: unknown, raw: string) => parseLexSearch(payload, lexNumber(LEX_TH, raw), LEX_TH);
