# ecParcel

ecParcel, a logistics service of eCommax International Pty Ltd in Mount Waverley, Victoria, stores,
packs and ships online shops' orders and takes their returns. It delivers locally with its own
drivers and hands other parcels to partner couriers. Its site is ec-parcel.com. The adapter reads
the service its tracker at track.ec-parcel.com asks.

## How it works

1. `direct`: `GET /api/shipmentTracking/getShipmentTracking?trackingNumber=` on
   track.ec-parcel.com, as the tracker page's script asks it. No session or token is needed.
2. `retry`: the same request once more when the first fails to reach the service or hangs. The
   first try gets half of the budget.

## Notes

- An unknown number is HTTP 404 with the message "shipment tracking not found!". A missing route
  answers 404 under the same `NOT_FOUND` code with "Not Found", so only the message reads as not
  found. A 422 `VALIDATION_ERROR` is the service refusing the number's form.
- The service tells capitals from small letters and takes letters and digits only, so the number
  is sent in capitals without separators. The reply's `shipmentTrackingNumber` must be the number
  asked.
- Depot scans carry an offset, `+10:00` in the sample, and the first scans are in UTC (`Z`): both
  are read as instants.
- Each scan is filed under a status, `InfoReceived`, `InTransit`, `OutForDelivery` or `Delivered`,
  and the first ones under a sub-status such as `InTransit_001`. The sub-status, else the status, is
  the provider code. The collection is filed under transit and reads as accepted. Transit is
  every depot scan's status, so a scan filed under it whose wording reads as another stage, a return
  for instance, takes that stage. Other statuses are read by their wording.
- A scan's place is the reply's `location`: a suburb with its state, then the country.

## Limitations

- The reply names no partner courier and no partner number, so no hand-off is made.
- It gives no delivery estimate and no proof of delivery.

## Numbers

The public sample is `YOTN`, its first scan's day as `YYYYMMDD` and nine digits. A rule claims that
shape. Other shapes are tracked when the carrier is selected. The sample and its source are in
[`numbers.json`](numbers.json).

## Links

Tracking links open its tracker with the number in the `trackingNumber` parameter.

## Testing

`npm run test:carriers:live -- carriers/ecparcel`

Set `ECPARCEL_TRACKING_NUMBER` outside the repository to check another shipment, and
`ECPARCEL_UNKNOWN_NUMBER` to replace the synthetic unknown number.
