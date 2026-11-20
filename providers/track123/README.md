# Track123 public tracking

Opt-in provider for named shipments of the carriers listed in [couriers.ts](couriers.ts). Each has a public courier page, `https://www.track123.com/carriers/{code}`, whose guest lookup is one query behind Tencent's invisible check, then polls until Track123 has read the courier. No paid API, account or stored verification proof is used. Set `providers: ['Track123', ...]` to enable it. A lookup without a carrier, or for a carrier not listed, is refused with `unsupported_scope`.

The browser helper does not load that page, which takes longer than the lookup itself. In a fresh context it serves a blank document at the page's address, runs Tencent's check there under the application id the page names, and sends the page's two requests from that document within one deadline: the query, naming the courier code and the whole number with the check's ticket, then a poll for the shipment's courier id every 300 ms while the reply says `querying`. Each request carries the `Track-Key` header the page computes from the request's time and body, an MD5 whose second and third initial words differ from the standard's. A ticket that Tencent's service marks as its fallback (`trerror_`) is asked again, as the page does. The final reply must name the same courier, echo the number and finish querying. Every event must repeat that number. A challenge, unfinished poll or refused guest request remains a failure so the next enabled provider can run.

A courier is listed only after one of its public numbers came back with history from its page. Track123's own detection is not used: asking a courier page names the carrier, so the answer cannot come from a carrier sharing the number's shape. Track123 lists one code per courier, so a catalog carrier with several services maps to the code that answered its numbers.

Empty history is `NoHistoryError`, except when Track123 marks the courier's site as unreadable (`nodeStatus` `UNSTABLE_OFFICIAL_WEBSITE`): that answer is about the courier, not the parcel, and fails as `carrier_unavailable`. Event clocks retain their wall time and explicit offset; a conflicting UTC field is rejected. Recipient fields and verification material are removed before the reply leaves the browser.

Run the configured facade with a public reference supplied outside source:

```sh
TRACK123_LIVE_CARRIER=ups TRACK123_LIVE_NUMBER=... FLARESOLVERR_URL=... node --input-type=module -e '
import { UniversalTracker } from "universal-parcel-scraper/node";
const tracker = new UniversalTracker({ providers: ["Track123"], environment: { env: process.env } });
const result = await tracker.fetch(process.env.TRACK123_LIVE_NUMBER, null, {}, null, process.env.TRACK123_LIVE_CARRIER);
console.log({ events: result.events?.length, provider: result.tracking_provider });'
```

Tencent's check may ask for a visitor's answer, which this helper cannot give; the lookup then fails as a challenge. Track123 answers `B0001` to queries from an address that sent about a dozen within a quarter of an hour, which fails as `guest_refused`. A poll for a number and courier id that Track123 read recently answers from its stored copy without a ticket; the helper does not use it, since a number Track123 has not stored answers there like one without history. Track123 reads some couriers' sites slowly, so an answer can take most of the default 30 s budget. Couriers that Track123's list marks as needing a postcode (`postalFlag`) answer an empty history at once without asking the courier, so none is listed.
