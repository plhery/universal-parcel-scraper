# Fraktjakt

Fraktjakt is a Swedish parcel and pallet booking network. Select it explicitly with the
32-character tracking code from a public Fraktjakt shipment link, or paste the complete
link. The tracking code is documented separately from the order API shipment ID.

## How it works

The adapter opens the public `GET /trace/shipment/{trackingCode}?locale=en` page and
reads the shipment’s scan timeline. The request uses the code alone, has no account
or session requirement and declines redirects. The guest shipping and tracking
interfaces are documented in the [Fraktjakt API guide](https://www.fraktjakt.se/downloads/Fraktjakt_API_en.pdf).

## Notes

- The timeline can contain partner scans and Fraktjakt’s own booking record. It already
  orders those scans, including ones recorded in different time zones. The adapter keeps
  that order and records the displayed dates and times as local clocks.
- The progress bar can say “Delivered and signed” for a shipment returned to its sender.
  Current status follows the latest shipment scan with a known stage. Investigation
  closures and recipient notifications stay visible in history.
- Location is limited to named places or countries. Account names, addresses, contact
  information and proof-of-delivery details are omitted.

## Limitations

The main Fraktjakt search page also accepts numbers issued by partner carriers. The
adapter covers Fraktjakt’s own shipment links. A bare 32-character code requires an
explicit carrier selection.

## Testing

```sh
npm test -- carriers/fraktjakt
FRAKTJAKT_TRACKING_CODE=<published-code> npm run test:carriers:live -- carriers/fraktjakt
npm run test:search-pages -- -t fraktjakt
```

The offline fixtures retain the public shipment timelines and omit personal fields.
