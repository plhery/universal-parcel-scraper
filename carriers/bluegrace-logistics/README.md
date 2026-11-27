# BlueGrace Logistics

BlueGrace Logistics is a US freight broker that books LTL and truckload carriers. Its tracking page
looks a shipment up by BlueGrace's bill of lading, BG and nine digits, or by the booked carrier's
PRO number, and lists the carrier's X12 214 status rows.

## How it works

1. `direct`: `GET https://mybluegrace.com/track/` for the nonce the page gives its lookup in
   `bluegraceTracking`, then `GET /wp-admin/admin-ajax.php?action=bluegrace_shipment_search` with
   `refName=BOL` and the number. When no bill of lading matches, the same nonce asks with
   `refName=PRO`. An empty list for both is the tracker's answer for an unknown number.
2. `retry`: one more read when the first fails to reach the site or hangs, in the rest of the budget.

## Notes

- The page is read at an address with a throwaway query. Cloudflare and WP Engine cache copies of
  the page whose nonce WordPress no longer accepts; a refused nonce (HTTP 403 and `-1`) after a
  fresh page means the site changed, so it is a schema failure rather than an absence.
- A shipment must name the whole number: its bill of lading, or for a PRO lookup one of its PRO
  numbers. Carriers reuse PRO numbers, so a PRO number that several bills of lading share is
  inconclusive. The record BlueGrace keeps for its integration tests is rejected.
- The rows carry no zone. A row in a state with one zone is dated on that zone's clock as a place
  basis, unless that would date it after the read; a row in a state with two zones, such as Texas,
  keeps its wall clock alone.
- Estimated delivery (`AG`) and delivery appointment (`AB`) rows are forecasts, not scans. The
  estimate is the tracking record's, else the newest such row's day. The booking's delivery window,
  which the page falls back to, is the shipper's request and is not read.
- En route to the delivery location (`X6`) is out for delivery when the row's state is the
  consignee's, as the page reads it, and in transit elsewhere. Delivered to a connecting line (`J1`)
  is a hand-over to another carrier, not a delivery.
- When the booked carrier's SCAC names a carrier in the catalog and the shipment has one PRO number
  of its own, the result hands over to that carrier under its PRO number.
- The parties' names, streets, contacts and postcodes, the goods and the comments are not read;
  only the parties' countries and the consignee's state are, for the clocks and the `X6` rule.

## Limitations

- Detection does not offer BlueGrace: its bills of lading take the shape of GLS Italy's numbers.
- Rows in states with two zones get no offset. The tracker shows no signatory or proof of delivery.

## Testing

`npm run test:carriers:live -- carriers/bluegrace-logistics`
