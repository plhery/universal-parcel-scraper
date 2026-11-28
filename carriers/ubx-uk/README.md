# UBX UK

UBX UK (United Business Xpress) is a Slough courier for international and domestic express. Its site is
ubx.uk.net. Select the carrier explicitly.

## How it works

1. `direct`: one `POST https://ubx.couriernavigator-secure.com/json/search/trackingdownload` with the number
   as `consign_note`, the search the tracking page on ubx.uk.net makes. There is no login, cookie, CAPTCHA or
   browser. The reply is a script, `trackingdownload({...})`, whose JSON lists the jobs found.

Its tracker runs on Courier Navigator, courier software that World Package, Hart2Hart Express, Flight
Logistics and eCourier use too. [courier-navigator.ts](courier-navigator.ts) reads the search for all five,
and [status.ts](status.ts) holds the platform's status ids.

## Notes

- The reader is written from the page's own scripts: the inline `trackingdownload` callback,
  `job.data.jquery.js` and `wms.timeline.js`. No public number has shown a found job, so the fixtures are
  synthetic, shaped as those scripts read the reply.
- The job must carry the number asked as its consignment note, the page's heading, or as its job id.
- An empty job list that echoes the number asked is the page's "It has not been possible to find a matching
  consignment", read as not found. An error list, an echo of another number, a page instead of the script or a
  malformed reply is a failure, never a missing parcel. A job without events has no history.
- Each event's `time_stamp` is a date and time without a zone, which the page shows as it stands, so events
  keep wall clocks.
- Events are staged by their `statusid`, as the pages read it: below 11 the job waits for its collection,
  11 is the collection, 19 and 20 are the delivery, and above 30 the job is cancelled. Between 11 and 20 the
  job is on its way, and wording such as "out for delivery" says which step. From 21 to 30 the page still
  counts the job delivered; those steps keep the delivery.
- A job handed to another network carries that network's reference in `agentref`, which the page shows as
  the forwarding reference, and a `link` such as `courier::dpd`, for which the page opens that network's
  tracker. The adapter hands on the reference and names the network when the reference has that network's
  shape. GLS Ireland, which the page links, is not in the catalog.
- Event details, signatures, the map and the collection and delivery addresses are not read. The delivery
  address's slot fields are listed as unread estimates when the reply fills them.

## Limitations

- No found reply has been seen; the fixtures are synthetic and the event wording is invented.

## Numbers

No public page shows a UBX UK number, so there is no rule.

## Links

The tracking page opens numbers from its `consign_note` parameter, on ubx.uk.net and on its Courier Navigator host.

## Testing

Set `UBX_UK_TRACKING_NUMBER` and optionally `UBX_UK_UNKNOWN_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/ubx-uk`.
