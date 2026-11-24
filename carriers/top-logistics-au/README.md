# Top Logistics Australia

Top Logistics Australia is a Sydney forwarder clearing low-value e-commerce imports and handing parcels to
Australian delivery carriers. Its site is toplogistics.com.au.

## How it works

1. `direct`: reads `imshk.toplogistics.com.au/customerService/imparcelTracking?s=<number>`, the tracking
   frame the site's search opens. The page names the parcel's reference, its route and an indicative
   schedule, its most recent status, its history, and the courier the parcel was despatched to.
2. `retry`: a read that fails to reach the frame, or hangs, is made once more. The first try gets half
   of the budget.

- No session, token or CAPTCHA.
- The page must name the number asked. The frame also matches other references and then shows another
  parcel, which leaves the answer open.
- A number the frame does not know gets an empty HTTP 500, the answer a failed lookup also gives, so it
  leaves the answer open. The frame has no not-found page. A block page is a challenge, a redirect or a
  404 a moved tracker, and a page without the history a changed one.

## Notes

- The history lists days, each with its scans on a wall clock to the minute. Times carry no zone and
  are kept in `local_time`. A sea freight scan has no time and keeps its day.
- The scan wording sets the stage. Vessel scans go on with the vessel and voyage, and the courier's scan
  with the courier's name and number.
- Under "Website to track" the page names the courier and links its site with the courier's number. The
  courier becomes the delivery carrier only when the page gives one courier, its name or site is one
  catalog carrier's, and detection offers that carrier for the courier's number. The courier's number is
  kept when it differs from the one asked. Allied Express, the sample's courier, tracks the parcel under
  the same number.
- The page's script holds the recipient's postcode to check an enquiry. It is never read.

## Limitations

- An unknown number cannot be told apart from a failed lookup, so it is never read as not found.
- No public page lists the frame's scan wordings: one missing from [`statuses.json`](statuses.json) is
  read by the shared wording rules.
- The courier's scans the page relays carry no place.

## Numbers

Top Logistics publishes no layout for its references. The adapter takes 6 to 40 letters and digits with
at least one digit, in capitals. Detection has no rule. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The site's search opens numbers from its `s` parameter.

## Testing

`npm run test:carriers:live -- carriers/top-logistics-au`

The live test tracks the sample in `numbers.json` and checks that an invented number is left open;
`TOP_LOGISTICS_AU_TRACKING_NUMBER` tracks another number, and `TOP_LOGISTICS_AU_UNKNOWN_NUMBER` another
unknown one.
