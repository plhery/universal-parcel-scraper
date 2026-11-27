# Ordertracker

Universal provider for the parcels of the carriers listed in [feeds.ts](feeds.ts), asked only
about the carrier a lookup is for. Persisted provider name: `Ordertracker`. Link shown to users:
`https://www.ordertracker.com/track/{number}`.

## Retrieval

One anonymous `GET https://api.ordertracker.com/public/mobile-tracking/data?trackingNumber={number}&lang=en`,
the request Ordertracker's Android app makes. The app sends an `X-Mobile-Secret` header that is
the same for every install, so the adapter carries it and consumers configure nothing. Result
labelled `tracking_source: structured-web-response`.

Ordertracker answers at once from its own copy of a parcel. Without one it reads the carriers
while the request waits, so the plan asks it after the fast HTTP providers when someone is
waiting ([COMPARISON.md](../COMPARISON.md)). For a number the carriers don't know, it answers
"No information" only after up to 45 s, and keeps that answer for later asks. The 50 s budget
waits for it: cut off at 30 s, those numbers came back as provider failures.

A request that hangs up does not stop the read. Until the read ends, another request for the
number gets "No information" at once, and after it the result. The adapter therefore takes
"No information" for the answer only from the request that started the read, or once the read's
47 s are over. Before that it waits for the read to end and asks again when the budget allows.
Otherwise the lookup fails with reason `still_reading` and the time left as `retryAfterMs`, as
it does when the budget ends during the first request. A retry after a failed request is
read the same way.

The parcels Ordertracker finds come within 13 s. A lookup with other providers left to ask
gives the first ask 15 s (`patienceMs` in [plan.ts](../plan.ts)), asks them, and comes back
with the whole budget. The adapter remembers its reads, so both asks go through one tracker.

"No information" and a reply with no feed for the number are `NoHistoryError`; a failed
request stays a provider failure. The reply does not repeat the number.

## Feeds and clocks

Ordertracker merges what several feeds relay about a parcel, each named in `events[].carrier.name`,
and writes every time as UTC. Some feeds give real instants, La Poste's for instance. Others give
the scanning place's wall clock marked UTC, as Pitney Bowes does for USPS and UPS. Mail Boxes Etc
does both for FedEx: a scan at a place east of Greenwich comes on that place's wall clock, as if the
plus sign of FedEx's offset were lost, and the others, the label without a place included, at their
instants. Its country decides which, and its town, or its country when the town is unknown, dates
the wall clock. [feeds.ts](feeds.ts)
lists the feeds whose scans count for each carrier, with their clocks. A scan at a wall clock's
midnight is dated by its day alone, and so is Mail Boxes Etc's at midnight UTC, the way it relays
the pickup FedEx dates by its day. Rows from other feeds are left out, and a reply with none of
the carrier's feeds is `unattributed_history`.

The milliseconds of a time number the scans: each feed's copy of one scan carries the same
number. The adapter reads the copies of a scan as one, on the clock of the first listed feed,
with the first wording the shared rules read and the first place. A wall clock is dated by its
place, then by the scans around it ([places/clocks.ts](../../places/clocks.ts)). A copy can keep
only the place; a scan with no wording in any copy helps date its neighbours and is then left
out. When the newest scan is such a scan, an older one cannot say where the parcel is, and the
lookup gives no history with reason `incomplete_history`. Pitney Bowes's copy of USPS scans does
this to some deliveries.

## Adding a carrier

Ask the carrier's benchmark numbers through the endpoint and compare every scan with the
carrier's own adapter, clock for clock, before listing a feed. Then run the benchmark for
Ordertracker, which grades it beside the other providers.

Feeds seen and not listed: DPD UK's, whose second line can be the sender's name; Hermes's,
whose milliseconds are real and number nothing; DHL eCommerce's, which lost the benchmark's
parcels after answering one of them; Mail Boxes Etc's copy of DHL Express, in Italian with
empty rows. Aramex, Landmark Global and DHL Parcel NL answered the benchmark's numbers and are
still to be compared. Royal Mail and Evri lookups time out.

## Live check

```sh
node scripts/benchmark.mjs probe --sources Ordertracker
```

asks every benchmark number of the listed carriers and merges the answers into
[results.jsonl](../../benchmark/results.jsonl). One lookup through the package:

```sh
ORDERTRACKER_LIVE_CARRIER=ups ORDERTRACKER_LIVE_NUMBER=... node --input-type=module -e '
import { UniversalTracker } from "universal-parcel-scraper/node";
const tracker = new UniversalTracker({ providers: ["Ordertracker"], environment: { env: process.env } });
const result = await tracker.fetch(process.env.ORDERTRACKER_LIVE_NUMBER, null, {}, null, process.env.ORDERTRACKER_LIVE_CARRIER);
console.log({ events: result.events?.length, stage: result.current_stage });'
```
