# GOFO Express

Tracks individual US parcels through the official anonymous tracking service.
Other regional services have separate scope: links to gofo.com's `/us` pages
and gofoexpress.com name this carrier. The French, Italian, Dutch and Spanish
portals name [GOFO France](../gofo-fr/README.md), [GOFO Italy](../gofo-it/README.md),
[GOFO Netherlands](../gofo-nl/README.md) and [GOFO Spain](../gofo-es/README.md).
[GOFO Canada](../gofo-ca/README.md) runs this service at its own path and shares
the adapter's tracker and parser.
The shared home page leaves the national service ambiguous.

## How it works

One bounded JSON POST asks for Pacific clocks, one of the public page's time
options. GOFO US waybills are `GFUS` and 14 digits, or the older `GF` and 13 series and
the `CR` and 12 series of CIRRO E-Commerce, formerly Parcll, which GOFO bought; its tracker still serves both. Detection only suggests GOFO, and
recognition asks it: for an AliExpress parcel GOFO shows only the label while
Cainiao's tracker follows the GFUS waybill from China, so recognition asks
[AliExpress](../aliexpress/README.md) too.

The waybill must be the requested number; the tracking number repeats it
or is the shipper's own reference, never another GOFO number. The exception is a
GFUS waybill whose tracking number is a CR number, an `MGP` and 13 digits number, or the
[DHLink](../dhlink/README.md) number (`FC` and 13 digits) of a DHgate parcel GOFO delivers:
asked for any of them, GOFO returns that one parcel, so each is tracked. Detection suggests
GOFO for `MGP` numbers and recognition asks it. Detection reads DHLink numbers as DHLink's;
the adapter takes them when the user picks GOFO or a tracking service names it. The
latest summary must agree with the first scan.

When the user picks GOFO, or opens a GOFO link carrying one, a YunExpress `YT`
number that GOFO delivers under the same number is sent too, and GOFO must give it
as both waybill and tracking number. Detection reads these numbers as YunExpress's. GOFO files a `YT` number
it does not deliver under another region, so that answer stays inconclusive.

The public page renders the whole list without paging and ignores the event
counter, which can count scans the list omits. A larger counter is accepted only
while the list still starts at label creation, so a list cut at either end stays
inconclusive, as do contradictory counts, regional reroutes and empty responses.
Only the explicit US error list proves absence. A failed envelope with numeric
code `20002` and explicit rate-limit wording raises `rate_limited` so callers can
back off. The code alone stays inconclusive, and no retry delay is invented.
GOFO's limit follows the overall rate from one address, not one parcel's: its refusals come in
spells that ease over half an hour to an hour, for parcels last read long before too. A pause
after a refusal would also hold back the many requests a spell still answers, so the catalog
lowers the overall rate instead: it asks for a refresh at most every half hour, and an hour after
a failed one. The adapter makes one request per lookup and never retries a refusal.
Failed replies retain their code and the message GOFO's page shows; a long message
or one quoting a number is left out.

## Notes

The page's default "Local Time" setting prints each scan's local clock with
Pacific's offset, which would put Mountain, Central and Eastern scans one to
three hours late. Each requested clock must carry Pacific's offset at that time,
and the instant is expressed in the scan's own zone when GOFO names a valid one.
Clocks without offsets remain local; incomplete clocks retain provider text
without advancing freshness. Current status comes from the latest scan, and
delivery requires confirming wording.
As on the public page, scan wording drops the support contact line GOFO appends
to some scans.
`service_name` is the `serviceName` GOFO gives, as written.
`expected_delivery` is GOFO's `estimatedArrivalTime`, kept as a date until the
parcel is delivered or returned.
Detailed delivery prose and proof images are excluded. The weight has no
verified unit and is omitted. Proof lookup requires a postcode and is not queried.

`clock.ts` lists the zone GOFO gave each station it named (`processLocation`) on the
corpus's and benchmark's parcels, for relays that keep only the station's name and its
wall clock (Ship24). A label is created on Pacific time wherever the parcel is, and a
delivery round, named after the recipient's town, kept its delivery station's zone. A round
that would borrow another zone from a hub before it is listed too: Pensacola's, whose station
in Cantonment is on Central time, after Orlando's hub on Eastern.

## Live test

Set `GOFO_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/gofo/adapter.live.test.ts`.
Optionally set `GOFO_UNKNOWN_NUMBER` to check explicit absence.
