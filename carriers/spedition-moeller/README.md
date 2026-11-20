# Artur Möller

Artur Möller is a German road freight carrier. Select it explicitly with the NVE
package barcode, an 18-digit identifier that may include the GS1 application prefix
`00` on the printed label.

## How it works

The carrier’s [public form](https://portal.spedition-moeller.com/tracking.html) sends
`POST /v1/public/tracking-live` with the barcode and page locale to its own API.
The adapter checks the echoed lookup and matches the barcode against the returned
package list. The carrier’s form publishes an example that returns 15 dated scans
from its local freight portal. The carrier also documents an ONLINE Systemlogistik
handoff when its local portal needs partner data. [Portal privacy policy](https://portal.spedition-moeller.com/datenschutz.html)

## Notes

- The current-status object determines the shipment stage. The native interface
  reverses the timeline so that the newest scan comes first.
- “Zur Verarbeitung angenommen” refers to acceptance of electronic data. Physical
  acceptance starts with the pickup scan. The depot loading scan does not by itself
  establish that a delivery attempt began.
- Timestamps with a stated offset are preserved as instants. Private addresses,
  documents and internal shipment IDs are outside the adapter output.

## Limitations

The carrier describes a 30-day public tracking window. The adapter supports the
documented NVE barcode form. Other reference types, including internal booking IDs,
have no verified example. Tracking is explicit because an NVE is shared across
freight networks.

## Testing

```sh
npm test -- carriers/spedition-moeller
MOELLER_TRACKING_NUMBER=<published-number> npm run test:carriers:live -- carriers/spedition-moeller
npm run test:tracking-links -- -t spedition-moeller
npm run test:search-pages -- -t spedition-moeller
```

The recorded fixture keeps shipment status evidence and omits internal identifiers.
