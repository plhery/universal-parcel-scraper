# SkyQuick International

SkyQuick International is an express courier based in Singapore. Its tracker is a GETOnline page
that Frontier Force hosts for it under the member id `stid=skyquick`. Tracked through that page.

## How it works

1. `direct`: one `GET https://tracking.frontierforce.com/go/plm-tracking?stid=skyquick&cn={number}`.
   It needs no cookie, token, key or browser. The server writes the history into the page's
   script, newest first within each of the page's sections: for each scan the number, the
   event's wording and number, its location and its clock.
2. `retry`: one more attempt after a network failure.

- The page and its parser are the ones SkyNet Worldwide Express and Airpak Express use, shared
  in [`getonline.ts`](../skynet-worldwide/getonline.ts).
- An unknown number gets the page's "No tracking found" notice. A 404 or a redirect is a moved
  route, an empty page is inconclusive and a firewall page is a challenge.
- Every scan must name the number asked.
- Recognition makes the same request.

## Notes

- `stid` picks SkyQuick's records and wordings. The tracker also holds SkyNet network
  shipments that SkyQuick's Singapore station handled, such as the sample, written in SkyQuick's
  words ("Arrived SkyQuick Facility") where SkyNet's own page has its own. The adapter sends
  only `skyquick`.
- The tracker answers more than whole numbers, so the adapter sends only eight to twenty letters
  and digits, the shapes SkyNet's network prints.
- Each scan's clock is the station's wall clock to the minute, with no zone. A scan in a country
  with one clock is dated on it; a scan in a country with several zones stays `local_time`.
- The event number stages a scan. A message to the recipient and a return to the depot move
  nothing.
- The service type, the sender's reference and the masked signatory are not kept. The
  proof of delivery, behind a check of the recipient's phone number, is not read.
- The site's tracking box opens `skyquickinternational.com/tracking.aspx?cn=`, a summary of the
  same records that shows the signatory's name in full. The adapter reads the GETOnline page.

## Limitations

- No ETA, weight, service name or delivery time as an instant.

## Numbers

Bare digit runs are printed by many carriers, so no rule claims them and preflight does not ask
SkyQuick: a number reaches the adapter when the user, a link or a provider names the carrier.
The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The library reads the number from `cn` on the site's `tracking.aspx` and on Frontier Force's
tracking pages that name `stid=skyquick`.

## Testing

`npm run test:carriers:live -- carriers/skyquick`, with `SKYQUICK_TRACKING_NUMBER` and optionally
`SKYQUICK_UNKNOWN_NUMBER` set outside the repository.
