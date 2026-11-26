# BabyXpress

BabyXpress is a courier in Sabah, Malaysia. It runs on Delyva, a Malaysian delivery platform whose
couriers each get a tenant at `<code>.delyva.app`; its own site framed the tenant's customer
tracker, which takes the consignment number.

## How it works

1. `direct`: posts the number to `api.delyva.app/v1.0/order/track` with BabyXpress's Delyva
   company id, as the tenant's tracker page does. `{"data": false}` is not found.
2. `retry`: a read that fails to reach the service, or hangs, is sent once more.

- [`delyva.ts`](delyva.ts) holds the request and the parser for any Delyva tenant, and
  [`delyvaStatus.ts`](delyvaStatus.ts) the platform's status codes. Another courier on Delyva
  needs its own company id: `companyInfo.id` in the payload of its tenant's
  `https://<code>.delyva.app/customer/track` page.
- The service needs no session or check. The reply must name the number asked and the
  tenant's company.

## Notes

- Scans keep the instant the platform wrote them, in UTC.
- A scan's description is the platform's wording, a dash, then the branch that scanned the parcel
  or the staff who delivered it. The branch becomes the place; the staff stay behind. A
  description in any other shape is a note that can name people, so the scan keeps its status
  text instead.
- The status codes come from the legend in the customer tracker's code. The current status
  keeps the reply's own status text, which is shorter than the legend's.
- The staff's names and phones, the map's coordinates, the origin and destination towns and the
  service codes stay behind; the destination gives the country.
- The tracker link is the tenant's page with `trackingNo` in its query, which it looks up on
  opening.

## Limitations

- No delivery estimate. The reply's `etaDuration` is not read: its unit is not documented and it
  stays set on delivered parcels.
- The proof of delivery asks for the recipient's phone digits.
- The reply's `extTrackUrl`, empty for BabyXpress's consignments, is not read.

## Numbers

The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/babyxpress`

The live test tracks the public sample in `numbers.json` and an invented number;
`BABYXPRESS_TRACKING_NUMBER` tracks another consignment, and `BABYXPRESS_UNKNOWN_NUMBER` checks
the not-found answer with another number.
