# Cargologic

Cargologic is the air-cargo ground handler at Zurich Airport. Its tracker shows, for any
airline's air waybill it handles, the steps the freight went through in its Zurich warehouses:
an export's acceptance and departure, an import's arrival and hand-over to the forwarder.

## How it works

1. `direct`: one `GET https://www.cargologic.com/.servlet/tracking/1.0/?awb=<prefix>-<4 digits> <4 digits>`,
   the request the tracking page's component sends, with no cookie, token or key. The reply is
   JSON: the waybill's kind (import or export), its stations, pieces and weight, and its steps
   in up to four positions, each with its Cargo-IMP code.
2. `retry`: one more attempt after a network failure.

- An unknown waybill is a 404 whose message names it ("Could not find AWB …" or "No Tracing
  Information available for …"). A message naming another waybill is inconclusive.
- A transit shipment is a 451 ("Type TRANSIT not allowed"), which the page answers with "please
  contact the respective carrier": inconclusive with the reason `tracking_withheld`, never not found.
- A redirect is a moved service, a page instead of JSON a challenge or a schema error.

## Notes

- Cargologic handles freight at Zurich Airport only, so a step is dated on Zurich's clock and
  located at Zurich, except a flight manifest, which announces goods still on their way.
- The 200 reply does not repeat the waybill; the request binds it.
- The page lists the steps a waybill of its kind goes through and marks those that happened.
  Steps not marked are left out, and a waybill with none is listed without history.
- The page explains the codes only in a German legend, also on its English page, and gives DLV
  NFD's wording there. The events use the codes' meanings in English.
- An export's last step at Cargologic is its departure, so it ends in transit. An import ends
  delivered when the forwarder takes the goods.
- The page sends Lufthansa Cargo's waybills (prefix 020) to Lufthansa Cargo's own tracker
  without asking the service, and so does the adapter.
- The stations, pieces and weight (its unit unstated) are not read.

## Limitations

- Only the Zurich handling: no flights elsewhere, no ETA and no delivery beyond the forwarder.

## Numbers

Every airline's air waybills share one format, a three-digit prefix and eight digits ending in
a mod-7 check digit, and Cargologic issues none of its own, so detection has no rule: a number
reaches the adapter when the user or a provider names the carrier. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The page reads no waybill from its address, so there is no tracking link.

## Testing

`npm run test:carriers:live -- carriers/cargologic`

The live test tracks the first sample in `numbers.json`; `CARGOLOGIC_TRACKING_NUMBER` tracks
another waybill, and `CARGOLOGIC_UNKNOWN_NUMBER` checks the not-found answer with another number.
