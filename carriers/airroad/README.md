# AirRoad

AirRoad is an Australian express road freight carrier, majority owned by Senko since 2021. Its
site is airroad.com.au.

## How it works

1. `direct`: reads `my.airroad.com.au/api/QuickTrack/<number>`, the lookup the Quick Track page's
   script reads for each number. The reply holds the consignment's number, its current status with
   the status's time, whether it is delivered, and an estimated delivery date.
2. `retry`: a read that fails to reach the lookup, or hangs, is made once more. The first try gets
   half of the budget.

- No session, token or CAPTCHA.
- The reply must name the number asked. The lookup also matches other references and then answers
  with another consignment, which leaves the answer open.
- A number the lookup does not know gets HTTP 404 and "<number> not found.", read as not found when
  it names the number asked. Another refusal leaves the answer open; a block page is a challenge,
  a redirect or a 404 without that answer a moved tracker, and a reply of another shape a changed
  one.

## Notes

- The answer is the current status alone, marked `summary_only`, so enabled universal providers are
  asked for a history. The reply's scan list is always empty.
- Once a consignment is delivered, the status text names who took the goods, which the page shows
  as "Delivered to:" and the name. The adapter words the status Delivered and never reads the name.
- The status text sets the stage. A depot's scan names the depot, which becomes the scan's place.
- Times carry no zone, and AirRoad's depots span Australia's zones. They are kept in `local_time`.
- The estimate is kept while the consignment is on its way, unless its day is behind the status.

## Limitations

- No scan history: Quick Track shows the current status only.
- No public page lists AirRoad's status texts: one missing from [`statuses.json`](statuses.json) is
  read by the shared wording rules.
- The MyAirRoad customer portal's lookup, `my.airroad.com.au/api/track/?name=<number>&type=connote`,
  gives the last scan before the delivery, its time and the receiver's name. The portal sends a
  signed-in customer's token with it, so the adapter does not use it.

## Numbers

AirRoad publishes no layout for its consignment notes. The adapter takes 6 to 30 letters and digits
with at least one digit, in capitals, as the page sends them. Detection has no rule. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

The Quick Track page reads numbers from a form and opens no per-consignment page, so the catalog
sends people to it.

## Testing

`npm run test:carriers:live -- carriers/airroad`

The live test tracks the first sample in `numbers.json` and checks the not-found answer;
`AIRROAD_TRACKING_NUMBER` tracks another number, and `AIRROAD_UNKNOWN_NUMBER` another unknown one.
