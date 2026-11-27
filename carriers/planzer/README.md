# Planzer

Planzer, a Swiss transport group. Two kinds of shipment: ordinary deliveries,
tracked by shipment number through Planzer's keyless tracking API, and shared
shipments (`999.90.########`), which are not in the API and need the full shared
link with its `accessKey`. The same adapter serves
[quickpac](../quickpac/README.md), whose `44…` numbers use this API.

## How it works

`direct`, one bounded request. The factory picks the route: a parcel with a
tracking URL goes to the shared page, everything else to the API. The URL
decides the route; it is not a fallback tier.

1. API: `GET https://api.tracking.app.planzer.ch/api/v1/shipments/{shipment}/Pak`,
   10 s timeout. One replay after a transport failure or HTTP 502/503/504, or
   after a 429 with a `Retry-After` of at most 60 s, when the pause ends before
   the lookup does. Planzer answers an unknown number with an empty HTTP 404
   that sets the tracking app's `TnT-Correlation-Id` cookie, which is not
   found. Any other 404, such as a proxy's error page, is inconclusive: paths
   the app does not serve get HTTP 401.
2. Shared link: `GET https://trackandtrace.planzergroup.com/shared/sendungen/{number}?accessKey=…`,
   15 s timeout. The page has no status code; its five route steps are read from
   the markup (tooltip label names the stage, `text-primary` marks reached
   steps, `<time datetime>` gives the timestamp). A short page is not-found only
   when it shows Planzer's "no shipments found" notice; otherwise it is a
   schema error (maintenance, partial render).

## Numbers

A parcel number is `91`, the sender's six-digit Planzer customer number and a
serial the sender's software builds, without a check digit: 20 digits from
Planzer's [WooCommerce plugin](https://github.com/Webwirkung/Planzer-Shipping-for-WooCommerce/blob/1c34663c185197c25480a8e4d6e512e0dafeb28b/src/Package/Package.php),
21 from [erpnextswiss](https://github.com/libracore/erpnextswiss/blob/cda93389d281114060a63636da44e261e4490fea/erpnextswiss/erpnextswiss/planzer.py),
22 on some shops' labels. Customer 346097's block is Planzer's alone
(`planzer-2`). Other carriers print runs of 20 to 22 digits too, so
`planzer-91` only suggests Planzer, and keeps it to Switzerland
(`servedCountriesOnly`). A USPS PIC that passes its check stays USPS's.

Recognition asks the API about these 91 numbers only. A reply listing the
whole number as a parcel is known, Planzer's own 404 is unknown, and anything
else fails. A Swiss lookup asks Planzer beside the other carriers; any other
country, or none, only once they have all missed the number.

## Notes

- The shared URL is a capability URL. It must be `https://` on
  `trackandtrace.planzergroup.com`, with no credentials, port or fragment, a
  path whose number matches the tracked number, and exactly one well-formed
  `accessKey`. The key is never logged or stored in fixtures or docs.
- Planzer's messages print the shipment as a `reference.shipment` composite
  (`12345.0012345678`). Only the shipment half is looked up, without leading
  zeros. The app stores numbers without dots, so a 15-digit number made of a
  5-digit reference and a zero-padded 10-digit shipment is split the same way.
  The API does not return the reference, so only the shipment half is checked.
- A parcel number reads only the position whose `positionNumber` equals it: the
  reply can include positions of other shipments in the same delivery, and
  showing one would be a privacy failure. A shipment number is accepted when the
  reply's own `shipmentNumber` equals it; every position then belongs to that
  shipment, and a milestone the parcels repeat within 15 minutes is kept once.
- No detection rule points at the 8-digit shipment or the composite. Such a rule
  would make Planzer a candidate probe for other carriers' numbers
  ([ROUTING.md](https://github.com/plhery/delivery-tracker/blob/main/docs/ROUTING.md)), and a matching
  8-digit shipment is too weak an identity to adopt someone else's parcel. These
  numbers are tracked only when the user files the parcel under Planzer.
- An unfamiliar API milestone label is a `SchemaError`, not an unmapped event.
  The vocabulary is small and stable, so new wording is likely a schema change,
  and guessing risks a false delivery.
- Each milestone is classified on its own, not from the shipment status.
  Inheriting would stamp `delivered` on earlier events and make re-syncs
  duplicate history.
- `Shipped` means delivered: it is Planzer's mistranslation of `Zugestellt`
  (the same event reads `Livré` / `Consegnato`). It is classified as received
  and stored as `Delivered` via `PLANZER_WORDING`. Event identities hash the
  stored wording, so any new entry there needs a migration for saved rows, like
  `supabase/migrations/*_relabel_planzer_delivered_events.sql`.
- Shared-page step labels are in the recipient's language, so each stage is
  matched by substring and the stored description is our own neutral wording.
  This keeps history stable whatever language the page was fetched in.
- Neither route publishes scan locations. Timestamps have no offset; the host
  applies `Europe/Zurich`.
- The API gives each parcel's weight in grams and its length, width and height
  in millimetres. The result carries the total weight when every parcel read
  states one, and the measurements when a single parcel is read. The API's
  delivery address gives the recipient's name and address, else its consignee
  block does, and its country, which Planzer names in German. Who signed is
  read for a delivery; the signature image and the shared page's blocks are not.
- Once delivered, the delivery day is history: the estimate is cleared and the
  delivery scan's time becomes the delivery time.

## Rejected approaches

- Shared page as a second tier after the API — the API never knows shared
  shipments, so it would add a guaranteed failure per lookup.
- Mapping `Shipped` to a dispatch stage — the other-language fields on the same
  event say delivered.
- Rewriting `Shipped` at display time — the views only see text, and other
  carriers use `Shipped` for dispatch.
- Storing the German labels — every history would switch to German to fix one label.
- Adding `Expédié` / `Versandt` / `Spedito` as aliases — those mean dispatched;
  only equivalents of Planzer's own labels are mapped.

## Testing

`npm run test:carriers:live -- carriers/planzer`. Unknown-number
checks need no env vars. Set `QUICKPAC_DELIVERED_TRACKING_NUMBER` to a real
delivered Quickpac parcel to also check the four milestones and the `Shipped`
relabel.
