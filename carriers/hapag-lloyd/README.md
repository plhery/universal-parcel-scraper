# Hapag-Lloyd

Hapag-Lloyd is the German container line. Tracked through the lookup its public tracking page
makes for a container, a booking or a bill of lading, through the browser tracking service.

## How it works

1. `trawl`: the browser service opens `https://www.hapag-lloyd.com/solutions/tracking/#/<number>`
   in a fresh context. Cloudflare's check answers first and may ask for its checkbox; the page
   then runs its own Turnstile, which may ask too, and asks
   `https://tracking.api.hlag.cloud/api/tracking/v3/events?reference=<number>` with the token it
   got. Only that lookup for the whole number reaches the tracking service, at most twice, and the
   service hands back the containers' moves.

Without a Turnstile token the lookup is refused, and a script outside a browser gets Cloudflare's
block page, so there is no plain HTTP step. The browser service's Firefox passes both checks;
Chrome driven by Playwright is refused at the checkbox. No account, cookie or CAPTCHA solver is
needed.

## Notes

- A reply lists each container with its moves in order: done moves are `Actual`, the rest are
  planned and go to `planned_events`. A vessel's departure and arrival name no container.
- A gate move's wording does not say whether the container is empty or full, so its place among
  the moves decides its stage, as [statuses.json](statuses.json) says. A gate-out after the last
  discharge is out for delivery only by truck; by rail or barge the container is moving on.
- A booking's containers move apart. The booking is delivered once every container is back; until
  then the latest open stage leads. Moves the containers share are kept once.
- Scan times are the place's wall clock without a zone. Container types, weights, vessels and
  voyages are not read.
- An unknown number gets a not-found error key; one matching several shipments is inconclusive.

## Limitations

- A container lookup returns the container's latest booking, which may be another shipment than
  the one asked about.
- Bookings and bills of lading take the same lookup and reply, but no public one has answered with
  moves yet; a bill for a container repositioned empty is not found.
- The lookup's API version comes from a page setting. When the page moves to another version, the
  service captures nothing until the adapter follows.

## Numbers

Containers are ISO 6346 numbers, whose check digit is checked before the lookup. Bookings are up
to eight digits and bills of lading four letters and twelve letters or digits, as the page
accepts them. Detection has no rule. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

```sh
FLARESOLVERR_URL=http://127.0.0.1:8191 npx vitest run --config vitest.carriers-live.config.ts carriers/hapag-lloyd/adapter.live.test.ts
```

The live test tracks the public sample in `numbers.json` through the browser service at
`FLARESOLVERR_URL`; `HAPAG_LLOYD_TRACKING_NUMBER` tracks another number, and
`HAPAG_LLOYD_UNKNOWN_NUMBER` checks the not-found answer.
