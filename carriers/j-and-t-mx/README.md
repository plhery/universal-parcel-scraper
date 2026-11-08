# J&T Express Mexico

J&T Express Mexico runs its own network, site and tracker, apart from the Southeast Asian J&T
operations in `j-and-t`. Tracked through the lookup its tracking page makes, with the last four
digits of the recipient's or sender's phone the tracker asks for.

## How it works

1. `direct`: one
   `GET https://official.jtjms-mx.com/official/logisticsTracking/v3/getDetailByWaybillNo` with
   `waybillNo`, `langType` and the phone digits in `phoneVerify`, and the page's `langType`,
   `timezone` and empty `token` headers. It needs no cookie, key or browser. The JSON reply
   lists the waybill's scans in `data.details`, newest first.
2. `retry`: the same lookup once more after a request that does not reach the site or times out.

- The digits come from the optional `phoneDigits` input, which the catalog offers for this
  carrier. Without four digits the adapter asks for them (`input_required`) before any request,
  so a lookup without them goes to universal providers.
- Code 1350200268 refuses the digits. It is `input_required` with the reason
  `phone_digits_mismatch`, and universal providers answer instead.
- An unknown waybill is HTTP 200 with code 135020020, which the page reports as not found. A
  found waybill without scans has no history. Codes 999001010 and 999001030 refuse the request's
  parameters and are schema failures. A 404 or a redirect is a moved route, and a page in place
  of JSON is a challenge.
- Any waybill the reply names must be the one asked.
- The digits are a credential. They stay out of error messages and request diagnostics, and
  never reach a universal provider.

## Notes

- The reply's language follows the reader's: Spanish, English or Chinese, Spanish otherwise.
- A scan's description is the label the page lists it under. `statuses.json` holds no labels
  yet, so the shared wording rules stage the scans.
- A scan's location is the place set apart in brackets at the head of its sentence. The rest of
  the sentence names couriers and phones and is not read, nor are the origin and destination
  towns.
- The tracker writes each `scanTime` in the zone the request's `timezone` header names. The
  adapter asks for Mexico City's `GMT-0600` and reads every scan as an instant at `-06:00`.

## Limitations

- No ETA or weight.
- A lookup needs the phone digits; without them the history comes from universal providers.
- A scan in a zone other than Mexico City's has its instant at `-06:00`.
- A history longer than 100 scans keeps the newest 100.

## Numbers

J&T Express Mexico's tracker help says a waybill is `JMX` followed by twelve digits, the tracker
checks that shape, and archived lookups show it. `j-and-t-mx-1` claims it.

## Links

The tracker at `www.jtexpress.mx/trajectoryQuery` reads the waybill from `waybillNo`, as
archived lookups show. It asks for the phone digits before it shows the history.

## Testing

`npm run test:carriers:live -- carriers/j-and-t-mx`, with `J_AND_T_MX_TRACKING_NUMBER` and
`J_AND_T_MX_PHONE_DIGITS` set outside the repository.
