# Om Logistics

Om Logistics Supply Chain carries surface and express consignments in India and
neighbouring countries. Its dedicated adapter reads the
[official guest tracker](https://omlogisticssupplychain.com/track-shipment).

## Retrieval

The tracker opens a fresh cookie session at `/api/track?type=captcha`. Its SVG
contains positioned text glyphs; the adapter reads those glyphs, then submits
`cn_no` and `captcha_input` for `type=enquiry` and `type=details`. The summary must
name the whole docket before the dispatch-history request is made. A bare error
flag is inconclusive and leaves enabled provider fallback available.

Dispatch rows distinguish Out Date and Arrival Entry. Both keep their stated
wall clocks and date precision. Delivery and booking labels supply stages;
numeric row types are not status codes. The summary delivery clock can disagree
with the dispatch history, so it does not replace those scans. Invoice, item,
vehicle and proof-of-delivery fields are omitted. No document request is made.

The [OM CN Tracker Android app](https://play.google.com/store/apps/details?id=com.omlogistics.tracker)
builds a number-only POST to
`https://scmomsanchar.omlogistics.co.in/oracle/android_api/cn_enquiry_oracle.php`
with `status=omstaff` and `cn_no`. Its tracking screen supplies no account
credential, but this route is not used by the adapter.

## Numbers

Dockets overlap other carriers' numeric formats, so no detection rule claims
them. Explicit carrier selection and named handoffs can use the native adapter.

## Testing

`OM_LOGISTICS_TRACKING_NUMBER=… OM_LOGISTICS_UNKNOWN_NUMBER=… npm run test:live -- carriers/om-logistics/adapter.live.test.ts`
