# Dora Gate

Dora Gate (哆啦任意门科技) is a Shenzhen cross-border logistics company with small-parcel lines
to the United States and Japan and air and sea lines to Nigeria, Europe and North America. Its
waybills are tracked on AnserX's tracker, which its site's search opens.

## How it works

1. `direct`: one `GET https://oms.anserx.com/client/cs/anserxWebsite/tracking/getTrackInfo` with
   `nos={number}` and `internalFlag=0`, the request AnserX's tracking page makes.
   [`../anserx/adapter.ts`](../anserx/adapter.ts) sends it and
   [`../anserx/parser.ts`](../anserx/parser.ts) reads the reply. It needs no cookie, token or
   browser.
2. `retry`: a lookup that fails to reach the service, or hangs, runs once more within the
   budget. The first try gets half of the budget.

- A number the tracker does not know leaves the list empty and counts as abnormal, which is not
  found. Another envelope `code` than 0 is inconclusive, and a 404 or a redirect is a moved route.
- Only the shipment whose `waybillNo` is the whole number asked is read.

## Notes

- AnserX's own scans carry a `BTY_` code, mapped in [`statuses.json`](statuses.json), and are on
  Beijing time. The delivering carrier's scans are relayed as they are (`trackingType` 1),
  without a code and on that carrier's clock: USPS's delivery "at 11:33 am" in Mississippi is
  relayed as 11:33. Those keep their wall clocks, and the result keeps the tracker's order.
- The shipment's delivery number becomes `delivery_tracking_number`; detection names its carrier.
  The customer's account code and order reference are not kept.

## Limitations

- No ETA, weight or service.
- The catalog leaves AnserX's tracking links to AnserX, so a link opens nothing here.

## Numbers

The only public waybill is DOR, ten digits and CN. One sample is too few to claim the layout,
so no rule does and the adapter answers explicit selection. The sample and its source are in
[`numbers.json`](numbers.json).

## Testing

`DORA_GATE_TRACKING_NUMBER=DOR0232840364CN DORA_GATE_UNKNOWN_NUMBER=DOR0000000000CN npm run test:carriers:live -- carriers/dora-gate`
