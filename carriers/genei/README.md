# Genei

Genei arranges Spanish domestic and international shipments through partner carriers.
Its public tracking page sends the eight-character Genei shipment code to the
Genei JSON API. The adapter uses that same lookup and checks the code echoed on
each scan. Select Genei explicitly for its own shipment references.

The adapter orders scans by their UTC timestamps and uses Genei's history ID to
order scans with the same timestamp. GLS can mark the deposit into a ParcelShop
as delivered alongside a ready-for-pickup scan for the same parcel. The adapter
follows that pickup notice and removes only the matching deposit rows. It also
recognizes a partner's collection scan relayed under Genei's out-for-delivery code.
The output uses Genei's status labels and omits partner links and proof-of-delivery
details.

## Testing

`GENEI_TRACKING_NUMBER=… GENEI_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/genei`
