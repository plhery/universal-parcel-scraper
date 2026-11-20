# Peddler

Peddler parcels are read from Peddler's guest tracker, [track.pdlr.nl](https://track.pdlr.nl/),
through the browser service.

Peddler delivers in Dutch cities for its own clients and for partners such as Cainiao. PDN Express
is a separate carrier.

## Retrieval

The tracker's form posts the number with a Cloudflare Turnstile token. A verified submit sets a
cookie for that one number for about a quarter of an hour, and the page then asks
`/trackntrace/{number}?_data=routes%2Ftrackntrace.%24inquiryNumber` for its data. Without the
cookie, that request only sends the client back to the form. So every lookup needs a fresh
verification, and the adapter's only step is the [browser service's helper](../../trawl/peddler-browser.mjs).
The helper opens the form with the number filled in, lets the page's widget give it its token,
submits and captures the data request bound to the whole number.

The reply lists the events oldest first, each with its instant in UTC, a code and its wording in
English and Dutch. The adapter reads the English headline, adds a failed attempt's reason and
leaves out the courier's name, their position and the address of a delivery to a mailbox. A number
the tracker does not know gets a 404 with `Consignment not found`. A reply with the number alone
and no events is not a missing parcel: older parcels come back that way.

## Testing

```sh
FLARESOLVERR_URL=http://127.0.0.1:8191 npx vitest run --config vitest.carriers-live.config.ts carriers/peddler/adapter.live.test.ts
```

The live test tracks a public sample in `numbers.json` through the browser service at
`FLARESOLVERR_URL`; `PEDDLER_TRACKING_NUMBER` tracks another shipment.
