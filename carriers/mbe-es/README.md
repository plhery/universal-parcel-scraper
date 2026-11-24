# MBE Spain

Mail Boxes Etc. centres in Spain ship parcels with couriers such as UPS and give each shipment
an MBE code: ES, the centre's four digits, then two and ten letters or digits, written with two
hyphens. MBE Spain's tracker shows the courier's name, who signed and the courier's scans.
Tracked through that page.

## How it works

1. `direct`: one `GET https://www.mbe.es/es/tracking?c={code}`, the page the tracker's search
   form opens.
2. `retry`: one more request when the first fails to reach the site or hangs.
3. `trawl`: Akamai refuses the site to clients it takes for robots and answers them with HTTP 403
   "Access Denied". After that refusal, the configured browser service opens the same address and
   the adapter reads the page it renders. Rate limits, definite answers and changed pages do not
   launch a browser.

- A code the tracker does not hold gets its "no result" notice, read as not found. A page that
  answers another code is inconclusive.

## Notes

- The tracker finds a code only with its hyphens, so the adapter writes them back into a code
  given without them.
- The page names the courier, `(UPS)` beside the MBE code, but not the courier's own number, so no
  delivery carrier is set: it would be asked about the MBE code.
- Each scan is the courier's place, a hyphen, then its wording in Spanish. The place goes to the
  location and the wording is staged.
- The page gives clocks without a zone, so each scan keeps its wall clock as `local_time`.
- The signer and the delivery clock in the page's header are not kept; the delivered scan has the
  same clock.
- No detection rule claims the code yet; it is an open gap in
  [`core/detection/gaps.json`](../../core/detection/gaps.json) until more samples show its shape.

## Limitations

- No delivery estimate, weight, recipient or courier number.
- Only the courier's wordings seen so far are staged; others keep their text without a stage.
- TRAWL is required in practice: Akamai refuses HTTP clients and headless browsers.

## Testing

`npm run test:carriers:live -- carriers/mbe-es`, with `FLARESOLVERR_URL`,
`MBE_ES_TRACKING_NUMBER` and optionally `MBE_ES_UNKNOWN_NUMBER` set outside the repository.
