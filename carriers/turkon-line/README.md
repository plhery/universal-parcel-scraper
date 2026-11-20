# Turkon Line

Turkon Line is the Turkish container line. Tracked through the lookups its public tracking page
makes for a container or a booking, through the browser tracking service.

## How it works

1. `trawl`: the browser service opens `https://myturkonline.turkon.com/tracking` in a fresh
   context, waits for Cloudflare's check to reload the page, types the number into the page's
   search box and presses Enter. The page asks for the booking's milestones, then for each
   container's moves. Only those two lookups for the whole number go out, as a guest, and the
   service hands back the containers' moves.

Cloudflare checks every visitor of the page and of its lookups, and the page takes a number only
from its search box, so there is no plain HTTP step. Headless Chrome stays on the check. No
account, cookie or CAPTCHA is needed.

## Notes

- A bill of lading is `TRKU`, Turkon's carrier code, before the booking's digits. The tracker
  finds nothing for the bill as typed, so the adapter asks for the booking.
- A reply must name the booking, or the container, it was asked for.
- A move without a time, or marked as not yet done, is a planned move: it goes to
  `planned_events` with its day and sets no stage.
- The empty container's return is the delivery. One returned before it sailed is an unused
  container and has no stage. A full gate-in after the container sailed is transit. The codes are
  staged in [statuses.json](statuses.json).
- A booking's containers move apart. The booking is delivered once every container is back; until
  then the latest open stage leads. Moves the containers share are kept once.
- Scan times are wall clocks without a zone. Vessels, voyages, weights, dangerous goods, reefer
  settings and the empty return depot are not read; the milestones lookup repeats the moves by
  day and is not read either.

## Limitations

- A container lookup returns the container's latest booking, which may be a later shipment than
  the one asked about.
- A booking listed without moves is no history.

## Numbers

Containers are ISO 6346 numbers, whose check digit is checked before the lookup. Bookings are
digits, some behind an office's letters. Detection has no rule. The samples and their sources
are in [`numbers.json`](numbers.json).

## Testing

```sh
FLARESOLVERR_URL=http://127.0.0.1:8191 npx vitest run --config vitest.carriers-live.config.ts carriers/turkon-line/adapter.live.test.ts
```

The live test tracks the public sample in `numbers.json` through the browser service at
`FLARESOLVERR_URL`; `TURKON_LINE_TRACKING_NUMBER` tracks another number, and
`TURKON_LINE_UNKNOWN_NUMBER` checks the not-found answer.
