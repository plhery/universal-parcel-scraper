# HOTWMS

HOTWMS (皇家云仓) runs warehouses abroad and flies parcels from them to China, where it clears them
through customs and hands them to EMS for the last leg. Its site is hotwms.com. Tracked through the
service its tracking page asks.

## How it works

1. `direct`: one `GET https://api.hotwms.com/tracking/{number}`, with the tracking page's origin. It needs
   no cookie, token, account or browser. The reply is JSON: `body.tn` echoes the number and `body.steps`
   lists the steps newest first, each with a place, a wording and `ts`.
2. `retry`: one more request when the first fails to reach the service or hangs. The first gets half of the
   budget, so the retry fits in the rest.

- `body.tn` must be the whole number asked. With it, an empty `steps` is the service's answer for a number
  it holds nothing under, which is not found.
- `errCode`, `errorMessage` or `errMsg` is the service's own error, which the page shows instead of a
  history: inconclusive. HTML is a browser check or a changed route, and any status other than 200 is a
  moved route (the gateway answers 403 for a path it does not have).
- The tracking page, `http://www.hotwms.com/trace.html?nbr={number}`, answers plain HTTP only, so the
  catalog does not link it.

## Notes

- `ts` is an instant in epoch milliseconds, so each step keeps it as given; the page shows it on China's
  clock.
- Steps at the same instant keep the reply's order, which lists the newer first.
- The last step names the carrier of the last leg in brackets and its number: `已交付末段 [EMS]: {number}`.
  China Post, which runs EMS in China, becomes the delivery carrier with that number only when the bracket
  says EMS and China Post's own rules take the whole number. EMS's thirteen-digit domestic numbers are not
  among them, and China Post's adapter refuses them, so the step keeps the number in its wording and no
  delivery carrier is named. The map reads that step without the carrier's name and number.
- `待提货` is the bag waiting at the arrival airport for HOTWMS to collect it, not a parcel waiting for its
  recipient, so it reads as in transit.

## Limitations

- No delivery estimate, weight, service name, sender or recipient.
- Steps have no place in the sample; `place` is read as the location when the service gives one.
- After the hand-over the delivery is on EMS's tracker, under its own number.

## Numbers

The public sample is nineteen bare digits, a shape no prefix or check digit ties to HOTWMS, so no
detection rule names it. The adapter answers explicit selection of any number of 6 to 40 letters and
digits. The sample and its source are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/hotwms` tracks the public sample, or the number in
`HOTWMS_TRACKING_NUMBER`, and checks an invented number, or the one in `HOTWMS_UNKNOWN_NUMBER`, reads as
not found.
