# Vitran Express

Vitran Express is a Canadian less-than-truckload carrier of TFI International. The adapter looks
up one PRO bill number on Vitran's public Quick Track page, over plain HTTP.

## How it works

1. `direct`: `GET https://www.vitran.com/quicktrack.aspx?p={number}`, without a cookie, form post
   or browser. The server renders the answer beside the form: the current status, the PRO number,
   the pieces and weight, the origin and destination cities, the pickup day, an estimate while the
   shipment travels and the delivery day.
2. `retry`: the same request once more after a failed connection or a timeout. The first attempt
   gets half of the budget. An HTTP status is never sent again.

## Notes

- The answer is accepted only when the PRO number it prints is the number asked.
- The page keeps no scan history. The events are the pickup, at the origin city, and the
  delivery, at the destination city, once the status says delivered. The estimate is the result's
  `expected_delivery`, not an event. The result is marked `summary_only`, so enabled fallbacks are
  asked for scans.
- Days are printed month first, as a pickup before its delivery shows. They stay bare dates in
  `local_time`; text that is not a day goes to `provider_time_text`.
- The status is read by Vitran's wording, then the shared wording rules. A delivery day under
  another status, or a value between the pickup and delivery days that is not an estimate, is
  named in `unread_estimates` rather than read.
- A number the page holds nothing for gets "Not found." under the form, which posts back to that
  number; that page is not found. A bot check, a refusal, a redirect, a missing page or a page
  without the answer or that notice is never read as not found.
- The weight is converted to kilograms. The pieces are not kept.
- The site is not reachable from every country: lookups from some networks time out, and fail as
  a transport error.

## Limitations

- Only PRO bill numbers are looked up. The form's PO, BOL and pickup reference searches are not
  used.
- The estimate's label has not been seen on a live reply. It is read when the label names an
  estimate.

## Testing

`VITRAN_EXPRESS_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/vitran-express`

`VITRAN_EXPRESS_UNKNOWN_NUMBER` optionally checks that a made-up number reads as not found.
