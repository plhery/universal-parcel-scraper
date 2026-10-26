# Fixtures

Synthetic replies of the lookup track.jcex.com makes. `delivered.json` is a waybill from China
that USPS delivered in the United States: the order data without a place, the origin
warehouse's rows on China's offset, a repeated row, the timeline JCEX writes after taking the
parcel in, the Hong Kong hub's rows filed under the destination with its offset, the destination's customs and USPS's scans relayed with their
offset, some naming a state and some only the country. `handed-over.json` is a waybill for
France: JCEX's handover to Colissimo's depot, filed as delivered and listed first, then
Colissimo's scans on France's clock under China's offset, up to a failed visit. `not-found.json` is the answer for an
unknown number and `no-scans.json` the answer for a waybill JCEX has printed but not scanned.

Numbers, references, places, postcodes and clocks are invented.
