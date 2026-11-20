/**
 * Track123's courier codes for catalog carriers, from its public courier list
 * (`www.track123.com/tk/api/v2/anonymous/track/list-logistics-providers`, which
 * the courier pages read), with the name it shows. Listed are carriers whose
 * public numbers its courier page `www.track123.com/carriers/{code}` answered
 * with history bound to the number and the code. Ask a public number of the
 * carrier on that page before adding one.
 */
const COURIER_CODES: Readonly<Record<string, string>> = {
  'aliexpress': 'cainiao', // Cainiao
  'canada-post': 'canada-post', // Canada Post: the answer can take half a minute
  'china-post': 'china-post', // China Post
  'correos-spain': 'correos-spain', // Correos Spain
  'dhl': 'dhl-germany', // DHL Paket
  'dhl-express': 'dhl', // DHL
  'dpd-de': 'dpd-de', // DPD(DE)
  'dpd-fr': 'dpdfr', // DPD (FR)
  'dpd-pl': 'dpd-poland', // DPD(PL)
  'dpd-uk': 'dpd-uk', // DPD(UK)
  'evri': 'evri', // Evri
  'fedex': 'fedex', // FedEx
  'japan-post': 'japan-post', // Japan Post
  'la-poste': 'colissimo', // Colissimo
  'poste-italiane': 'poste-italiane', // Poste Italiane
  'purolator': 'purolator', // Purolator
  'ups': 'ups', // UPS
  'yunexpress': 'yunexpress', // YunExpress
};

/** Track123's courier code for a catalog carrier whose courier page answered a public number. */
export function track123CourierCode(carrier: string | null | undefined): string | undefined {
  return carrier && Object.hasOwn(COURIER_CODES, carrier) ? COURIER_CODES[carrier] : undefined;
}

/** The catalog carrier listed under a Track123 courier code. */
export function track123Carrier(code: string): string | undefined {
  return Object.keys(COURIER_CODES).find(carrier => COURIER_CODES[carrier] === code);
}
