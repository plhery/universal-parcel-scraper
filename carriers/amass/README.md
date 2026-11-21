# AMASS

AMASS (美设国际) is a Shanghai freight forwarder and NVOCC, mostly for less-than-container-load
ocean freight from China. The adapter tracks its house bills of lading and their order numbers
through the order tracking page's search.

## How it works

1. `direct`: the page's search, which answers a guest with the order's steps and no CAPTCHA. A
   search that fails to reach the tracker or times out gets one `retry`.

## Notes

- The search takes the house bill whole or the order's nine digits, and answers with the order
  number, which the adapter checks.
- Steps carry epoch milliseconds, so events set `time`. The English wording is kept; the Chinese
  one stands in when a step has none.
- The house bill's document steps and the advance customs entry carry no stage.
- The page reads code `302` as an unknown number. It asks a guest to log in or to open a booking
  account for some orders; those read as withheld tracking.

## Limitations

- The origin, destination, weight and piece count are shown only to the booking account.
- The step lists the page draws as progress rails, with their arrival estimate, are not kept.
- The tracker takes about twenty seconds to answer for a number it does not hold, so the first
  search gets the whole budget and no retry fits after a hang.

## Testing

`AMASS_TRACKING_NUMBER=<house bill> AMASS_UNKNOWN_NUMBER=<invented bill> npm run test:carriers:live -- carriers/amass`
