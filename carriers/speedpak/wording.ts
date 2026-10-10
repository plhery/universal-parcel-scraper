import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';

/**
 * A hand-off line can give a USPS routing barcode as the last-mile reference.
 * It opens with the recipient's ZIP code, so the line keeps only the package
 * identifier after it, and no reference when that cannot be split off.
 */
export function withoutRoutingPrefix(text: string): string {
  return text.replace(/\[(420\d{27,35})\]/g, (whole, reference: string) => {
    if (!USPS_ROUTING_BARCODE.test(reference)) return whole;
    const pic = uspsPackageIdentifier(reference);
    return pic ? `[${pic}]` : '[]';
  });
}
