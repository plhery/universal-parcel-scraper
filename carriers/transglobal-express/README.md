# Transglobal Express

Transglobal Express is a UK parcel broker: it books parcels with partner couriers such as Evri
and Spring, collects some itself and tracks each order under its own TP- reference. Tracked
through the reference form on its UK website.

## How it works

1. `trawl`: the browser service opens the form at `transglobalexpress.co.uk/track-shipment/`
   once Cloudflare lets it load, types the whole reference and submits it. The
   [helper](../../trawl/transglobal-express-browser.mjs) lets that one post through. The form
   redirects a reference it knows to `/Tracking/TrackShipmentNEW/` for that order, and the helper
   checks that the redirect names the reference's order number. It passes on the result page's
   legs and dated rows, without the page around them, the parcel images or the redirect's address.

- The redirect's address carries the order's delivery postcode, which the result page needs and
  the form supplies. No row or log keeps it.
- Cloudflare guards every page under `/Tracking/` and challenges the form's post from a browser
  that reports automation; the helper reports such a challenge, which the adapter reads as one.
- A reference the form does not know comes back to the form with `Order not found`, which is not
  found. An order the page lists without rows has no history yet.
- `/Tracking/Track?id=<reference>`, which the site's header search calls, answers with the partner
  courier's tracking link alone, so the adapter does not use it.

## Notes

- Rows are Transglobal's own, for the booking, the collection and its depot, and the partner's,
  relayed in the partner's words. They are staged by their wording; a wording the map does not
  know falls to the shared English rules.
- The page dates a day's rows under a heading such as `Friday, October 23, 2026` and gives each a
  minute, without a zone. Rows keep their wall clock: a partner abroad may write its own.
- The location column also holds a booking's `Awaiting Collection` or `Awaiting drop-off` and a
  collection's `In Transit`. They are no places, and the adapter leaves them out.
- The leg marked `(Main)` names the partner and its number, which the adapter gives as
  `delivery_tracking_number`, with `delivery_carrier` for the partners the page has been seen to
  name: Evri and Spring.

## Limitations

- No delivery estimate, signature or proof of delivery. The parcel images need an account.
- A collection leg's own partner, when an order has one, is not read.

## Numbers

A reference is `TP-` and the order number, eight digits on current orders. The adapter takes TP
and 6 to 9 digits, with or without the hyphen. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The form takes a reference only from its own post, so no address opens an order.

## Testing

```sh
FLARESOLVERR_URL=http://127.0.0.1:8191 npx vitest run --config vitest.carriers-live.config.ts carriers/transglobal-express/adapter.live.test.ts
```

The live test tracks a public sample in `numbers.json` through the browser service at
`FLARESOLVERR_URL`; `TRANSGLOBAL_EXPRESS_TRACKING_NUMBER` tracks another reference, and
`TRANSGLOBAL_EXPRESS_UNKNOWN_NUMBER` checks the not-found answer.
