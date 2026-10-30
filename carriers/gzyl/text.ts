import { clean } from '../../core/transport/text.js';

// Four to six digits standing alone in scan text are a postcode far more often than anything else.
const POSTCODE_RUN = /(^|[^\p{L}\p{N}])\d{4,6}(?![\p{L}\p{N}])/gu;
// The postcodes written otherwise in a delivery row's place: three and two digits (Greece, Czechia,
// Slovakia, Sweden), two and three or four and three with a dash (Poland, Portugal), letters and digits
// (Canada, the United Kingdom) and four digits and two letters (the Netherlands).
const POSTCODE_FORM = /(^|[^\p{L}\p{N}])(?:\d{3} \d{2}|\d{2}-\d{3}|\d{4}-\d{3}|[A-Z]\d[A-Z] ?\d[A-Z]\d|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}|\d{4} ?[A-Z]{2})(?![\p{L}\p{N}])/gu;
// A signatory's name follows these markers.
const SIGNATORY = /(?:签收人|signed (?:for )?by|signatory)[\s\S]*$/i;

// The interface replies in GBK, which has no room for some spaces: one between two words arrives as `?`.
const LOST_SPACE = /(?<=\p{L})\?(?=\p{L})/gu;

/** Scan text without a signatory or a postcode. */
export function hualeiScanText(value: string, maxLength = 500): string {
  return clean(value.replace(LOST_SPACE, ' ').replace(SIGNATORY, '').replace(POSTCODE_FORM, '$1').replace(POSTCODE_RUN, '$1'), maxLength)
    .replace(/^[\s,，:：;；/]+|[\s,，:：;；/]+$/g, '');
}
