# BoxC

BoxC is the brand of BoxC Logistics, Inc. in New York. It consolidates e-commerce parcels in
China, scanning them in Shenzhen, and hands them to USPS, DHL eCommerce or other final-mile
carriers. Its site is boxc.com.

## How it works

1. `direct`: posts `{"trackingNumber": <number>}` as JSON to `boxc.com/api/track`, as the tracking
   page's script does. The reply names the shipment's number, its status, the final-mile carrier,
   the service, the destination and the shipment's events, newest first.
2. `retry`: a read that fails to reach the tracker, or hangs, is made once more. The first try gets
   half of the budget.

- No session, token or CAPTCHA.
- The reply must name the number asked; another shipment's reply leaves the answer open.
- A number the tracker holds no shipment under gets `success: false` and "Shipment not found", with
  HTTP 200, read as not found. The reply does not repeat the number; the request for it does.
  Another refusal leaves the answer open; a block page is a challenge, a redirect or a 404 without
  the tracker's JSON a moved tracker, and a reply of another shape a changed one.

## Notes

- The public samples' replies hold no events, so their answer is the status alone, marked
  `summary_only`, and enabled universal providers are asked for a history.
- Events are read as BoxC's API documentation defines them: a code from its event dictionary, which
  sets the stage, its wording, the time and the place. A wording missing from
  [`statuses.json`](statuses.json) is read by the shared wording rules.
- Event times are the scan's wall clock without a zone, and the first, middle and last miles span
  China, the United States and the destination. They are kept in `local_time`; a time that states
  its offset keeps it.
- The final-mile carrier is kept as the delivery carrier only when its name is one catalog carrier's
  and that carrier's rules fit the number asked.
- The destination's town and province, event postcodes and coordinates, the merchant's order
  number, BoxC's shipment id and the delivery images are never read.

## Limitations

- No estimate, and the status carries no time.
- A reply under another of the shipment's numbers leaves the answer open, as another shipment's
  would.

## Numbers

BoxC tracks a shipment by its final-mile number or by the number of its own generic label. The
adapter takes 8 to 40 letters and digits with at least one digit, in capitals, as the page checks
them. The final-mile numbers belong to USPS, DHL eCommerce, national posts and other carriers, so
detection has no rule. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`boxc.com/track/<number>` opens the tracking page with the number in its field. The link names BoxC
only for its own numbers, so a final-mile number in it is detected on its own.

## Testing

`npm run test:carriers:live -- carriers/boxc`

The live test tracks the first sample in `numbers.json` and checks the not-found answer;
`BOXC_TRACKING_NUMBER` tracks another number, and `BOXC_UNKNOWN_NUMBER` another unknown one.
