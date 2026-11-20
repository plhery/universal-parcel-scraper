# Onex

Onex is a shop-and-ship forwarder delivering online purchases from its warehouses abroad to Armenia and
Georgia, and sending parcels from Armenia abroad. It also delivers in Armenia the orders some online shops
send there. Its site is onex.am.

## How it works

1. `trawl`: the browser service opens the English tracker, `onex.am/en/onextrack?track=<number>`, once
   Cloudflare lets the page load. The page posts the number to `/en/onextrack/findtrackingcodeimport`, and
   the service's [helper](../../trawl/onex-browser.mjs) captures that lookup alone.

- The reply has four parts: a shop order's events, an import's dates, an export's dates, and another
  carrier's scans of the inbound parcel. None of them means no parcel by that number, which is not found.
- The reply does not name the number, so the helper binds the lookup's whole form to it.
- The lookup needs no CSRF token, only Cloudflare's clearance, which a plain HTTP client does not get.

## Notes

- Events and dates are wall clocks without a zone. They stay in `local_time`.
- The import and export dates take the captions the page gives them, with codes, since both name a step
  "Received": an import is received by its customer, an export by Onex in Yerevan.
- The import shows an estimate until it is received, and the export until it is handed to the destination's
  post; the page does not show an estimate the tracker marks as unsure.
- Another carrier's scans of the inbound parcel are that carrier's history, not Onex's, and are not read.
  A reply that holds only them has no history.

## Limitations

- The intermediate hubs of an import or export come from a second lookup the page makes by Onex's box id,
  which is not read.
- No weight, transport mode, origin country, cost or tax. The export's postal number is not read.
- Only the shop order reply has been seen live; the import and export dates follow the page's script.

## Numbers

Onex tracks most parcels by the number of the carrier that brought them to its warehouse, and shop orders
by the shop's number, so there is no rule.

## Links

Its tracker opens numbers from its `track` parameter, but most are other carriers' numbers, so no link
names Onex.

## Testing

```sh
FLARESOLVERR_URL=http://127.0.0.1:8191 npx vitest run --config vitest.carriers-live.config.ts carriers/onex/adapter.live.test.ts
```

The live test tracks a public sample in `numbers.json` through the browser service at `FLARESOLVERR_URL`;
`ONEX_TRACKING_NUMBER` tracks another shipment.
