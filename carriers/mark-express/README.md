# Mark Express

Mark Express (Mark Express Pvt. Ltd.) is an Indian courier and cargo company with its head office in Kolkata, a
corporate office in New Delhi and franchise delivery points across India. The adapter reads one air waybill
number from the open tracker its home page's form opens, over plain HTTP.

## How it works

1. `direct`: `GET crm.markerp.in/Frm_DocTrackWeb.aspx?docno={number}`, without a cookie, captcha or browser. The
   page gives the number, the booking (from and to centers, day and clock, consignee), a status line, the
   transit scans and the delivery rows.
2. `retry`: the same request once more after a failed connection or a timeout. The first attempt gets half of
   the budget. An HTTP status is never sent again.

## Notes

- The tracker is the company's own copy of the CourierInfo courier software, which Shree Mahavir also runs; the
  host serves Mark Express alone. The page is accepted only when it names the number asked.
- The page names no zone. The booking, the scans and the delivery keep the office's wall clock in `local_time`.
  A row at exactly midnight keeps its day. Text that is not a day and clock goes to `provider_time_text`.
- An `OUT-Scan` row is worded "Out To" the next office, at the office it left; an `IN-Scan` row "Inward At" the
  office it reached. An inward scan at the delivering hub stays in transit. A scan type not seen yet keeps only
  its code, since its route could name someone.
- The status line, as "DELIVERED ON 26/06/26 BY THANE-HUB (MUMBAI)", gives the current stage when its wording
  is known; otherwise the newest staged row does.
- The page for a number the tracker holds nothing for echoes the number with every field empty, the status
  "Online Booking Of Specified A.W.B. Is Not Found..." and both tables with their headers alone; that page is
  not found. Any other page without those fields, a bot check or a redirect to the site's blank error page is
  never read as not found.
- The consignee is kept as `receiver_name`. The destination center, the delivery's receiver and scan, and the
  offices' addresses and phone numbers in the names' tooltips are not kept.

## Limitations

- Air waybill numbers are digits only; the public ones have nine. Runs of digits are shared by other
  carriers, so there is no detection rule, and the adapter is asked only for parcels saved as Mark Express.
- Older consignments lose their booking and rows, and then read as not found.

## Testing

`MARK_EXPRESS_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/mark-express`

`MARK_EXPRESS_UNKNOWN_NUMBER` optionally checks that a made-up number reads as not found.
