# Airwings India

Airwings India (Airwings Logistics Pvt. Ltd., formerly Airwings Courier Express (India) Pvt. Ltd.) is a Mumbai
international courier and cargo company of the Dubai-based Jashanmal group, with an office in Cochin. It sends
export and online shops' parcels worldwide and hands them to other carriers for the last leg. Its site is
airwingsindia.com. Select the carrier explicitly.

## How it works

1. `direct`: one `POST https://xpresion.airwingsindia.com/api/v1/Tracking/Tracking`, the open JSON service of
   Xpresion, a courier management system, with the number in `AWBNo`, `Type` `A` for an air waybill,
   `RequiredUrl` `yes` and the fixed login the tracking page sends for every visitor. There is no cookie,
   session, CAPTCHA or browser.

[xpresion.ts](xpresion.ts) reads the service for any courier on Xpresion, given its host, login, forwarding
fields and stages; PXC Pacific Global and Khubani Air Pack run the same service.

## Notes

- The page's script reads the shipment's air waybill, status, forwarding number and link, and each scan's date,
  time, location and status. The reply layout is the one PXC Pacific Global's Xpresion service returns, whose
  unknown-number reply is identical to Airwings India's. No public number has shown a found shipment, so the
  found fixture is synthetic.
- The shipment must be the number asked. An unknown number gets HTTP 200 with "AWB does not exist" and no
  shipment, read as not found. Any other refusal, a 404, a page instead of JSON or a malformed reply is a
  failure, never a missing shipment. A listed shipment without scans has no history and still hands on its
  forwarding number.
- Scans carry a date and a time of day without a zone, from Airwings India's offices and the forwarding
  carrier abroad, so they stay wall clocks.
- The page's "Forwarding No." is the forwarding carrier's number, which the page opens in that carrier's link,
  put after the link's last "=". The adapter hands the number on, and names the carrier when its name or link
  is a catalog carrier and the number has that carrier's shape.
- Scans are staged by the wording [statuses.json](statuses.json) records, then by the shared wording rules.
- The shipper, consignee and receiver names, the reference, the weight, the delivery summary and the
  proof-of-delivery image are in the reply and not read. The expected delivery date is listed as an unread
  estimate.

## Limitations

- The service's reference lookup, `Type` `R`, is not used.

## Numbers

Its tracker takes an air waybill or a reference number as free text, and its site gives no layout. No public
page shows an Airwings India number its tracker knows, so there is no rule. The last-mile carrier's number on a
forwarded parcel belongs to that carrier.

## Links

The tracking page reads the number from its `awbno` parameter and looks it up on load.

## Testing

Set `AIRWINGS_INDIA_TRACKING_NUMBER` and optionally `AIRWINGS_INDIA_UNKNOWN_NUMBER` outside the repository and
run `npm run test:carriers:live -- carriers/airwings-india`.
