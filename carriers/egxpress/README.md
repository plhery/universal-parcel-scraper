# EGXPRESS

EGXPRESS parcels use enabled universal providers. There is no dedicated adapter.

EGXPRESS (Egypt Express) is an Egyptian courier, FedEx's licensee and national network partner in Egypt, delivering
domestic parcels with cash on delivery. International FedEx air waybills stay with FedEx. Its site is
egyptexpress.com.eg.

## Numbers

Its domestic waybills are `FED`, the date as year, month and day, and eight digits, as the bulk-tracking example
file on its site shows. `egxpress-1` suggests them at low confidence, since that file is the only source. An
older label carries nine digits, a shape other carriers share, so no rule takes it.

## Why there is no adapter

Its tracking page reads an open JSON endpoint, `GET /umbraco/surface/home/GetDomesticTrack` on
www.egyptexpress.com.eg with the number in `_trackingID`, without a session or CAPTCHA. It finds a waybill from
the example file with its scans, on local clocks without an offset, and answers an unknown number with code `-1`
and HTTP 200. Its replies name the recipient and carry cash-on-delivery amounts, which an adapter must drop. No
adapter has been written for it yet.

## Links

The tracking page opens numbers from its `trackingID` parameter, in English and Arabic.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
