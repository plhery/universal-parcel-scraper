# Hi-Trans Express

Hi-Trans Express is an Australian road freight carrier. Its consignment summary on the JAIX
portal shows a consignment's status, its proof of pickup and delivery and its scans. Tracked
through that summary.

## How it works

1. `direct`: one `GET https://online.hi-trans.com.au/Connotes/ShowConsignmentSummary.aspx?Number={number}`,
   the page the track form on Hi-Trans's website opens. The server writes the consignment into
   a script as `window.consignment` before the page draws it: its number, status, sender,
   service and zones, its scans and its pickup and delivery records.
2. `retry`: one more request when the first fails to reach the site or hangs.
3. `trawl`: Cloudflare puts a managed challenge in front of the summary, and answers a direct
   request with it. After that challenge, the configured browser service opens the same address
   and the adapter reads the page it renders. Definite answers, rate limits and malformed
   replies do not launch a browser.

- A number the portal does not know gets the line `Consignment/Quote {number} not found`. A
  notice or consignment for another number is inconclusive.

## Notes

- A scan's clock is its depot's wall time without an offset. Each scan keeps it as
  `local_time`, and the depot's city gives the zone of the instant deduced for it
  (`time_zone_basis: place`): Brisbane's clock keeps standard time while Melbourne's and
  Sydney's go forward in summer. The reply's UTC record times of the scans fall within seconds
  of those instants. A depot outside the state capitals keeps the wall clock alone.
- Scans keep the page's order, the newest first, and their codes stage them. The page's
  wording differs from the Freight API's names for the same codes; both are in
  [statuses.json](statuses.json).
- The consignment's own status line, its zones, the pickup and delivery records with their
  signers' names and signatures, and the sender's reference are not kept. The sender's name
  and the service are.

## Limitations

- No delivery estimate, weight, item count or recipient.
- TRAWL is required in practice: the direct request meets Cloudflare's check.
- A consignment reaches the adapter when it is filed under Hi-Trans or opened from a summary
  link.

## Numbers

The Freight API documentation describes a consignment number of at most fifteen characters whose
prefix selects the sender's charge account, and its examples are letters then digits. The adapter
takes that shape. Many carriers print letters followed by a counter, so no rule claims it.

## Links

The home page's track form opens the summary with the number in `Number`.

Interparcel's [Hi-Trans tracker](https://au.interparcel.com/couriers/hi-trans-express/tracking)
covers shipments booked through Interparcel and asks for its booking reference. It does not
establish support for arbitrary Hi-Trans consignment notes.

## Testing

`npm run test:carriers:live -- carriers/hi-trans`, with `FLARESOLVERR_URL`,
`HI_TRANS_TRACKING_NUMBER` and optionally `HI_TRANS_UNKNOWN_NUMBER` set outside the repository.
