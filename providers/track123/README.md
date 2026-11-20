# Track123 public tracking

Opt-in provider for named shipments of the carriers listed in [couriers.ts](couriers.ts). Each has a public courier page, `https://www.track123.com/carriers/{code}`, that submits through the page's own guest verification and polls for history. No paid API, account or stored verification proof is used. Set `providers: ['Track123', ...]` to enable it. A lookup without a carrier, or for a carrier not listed, is refused with `unsupported_scope`.

The browser helper opens the courier page in a fresh context, fills the form and captures the query and its polling sequence within one deadline. The query must name the courier code and the whole number and nothing else; each poll must carry only that number. The final reply must name the same courier, echo the number and finish querying. Every event must repeat that number. A challenge, unfinished poll or refused guest request remains a failure so the next enabled provider can run.

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

The public page may require interactive verification that this helper cannot complete. It does not add challenge retries. Track123 reads some couriers' sites slowly, so an answer can take most of the default 30 s budget. Couriers that Track123's list marks as needing a postcode (`postalFlag`) answer an empty history at once without asking the courier, so none is listed.
