/**
 * DHL Paket's rows in its English, as a Chinese line relays a German parcel's history: its advice of
 * the parcel's data, its record of the parcel on its way to it, its first scan in Germany and its
 * transport to the delivery base. Their wall clocks are DHL Paket's, Germany's, before the hand-over
 * too: read so, they fall on DHL's own rows of the same steps.
 */
export const DHL_PAKET_ROW = /^The (?:instruction data for this shipment have been provided by the sender to DHL electronically|shipment is in transit to DHL|shipment has been processed in the parcel center of origin|shipment arrived in the region of recipient and will be transported to the delivery base in the next step)\.?$/;
export const DHL_PAKET_ZONE = 'Europe/Berlin';
