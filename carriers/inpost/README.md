# InPost

The Polish locker and courier network and its cross-border hubs (last mile in PL, IT, PT and
GB). Tracked through the keyless `inposteasy.com` hub API; no postcode or link needed.

## How it works

1. `direct`: one `GET https://inposteasy.com/api/tracking/{trackingNumber}`. No cookies,
   account or browser state. A hub-confirmed collection can also query ShipX
   for its pickup point within the remaining budget.
   - The echoed `trackingNumber` must match the request, otherwise `SchemaError`.
   - HTTP 404 is not-found only when the structured `NOT_FOUND` problem identifies the
     requested shipment, directly or inside the tracking-error wrapper. An unrecognized
     404 stays inconclusive. Long-expired numbers also return not-found.
   - Transient HTTP failures get one retry within the lookup budget. Other failures keep
     their HTTP status, retry window and bounded diagnostics. HTTP 500 stays inconclusive.

## Notes

- The parcel-level `status` code sets the overall stage and each event's own code sets that
  event's stage; the two are independent in the payload.
- A drop-off at a locker or a courier collection reads as accepted, a parcel handed to the
  courier for delivery as out for delivery, and a refusal as a failed attempt.
- An unmapped code gets no stage: the phase prefix does not decide it. The result is
  `unknown` with the raw wording kept, and the sync records it for review.
- Timestamps are kept exactly as sent with their offset. An offset-less value is dropped,
  not stamped with `Europe/Warsaw`, because four countries share this endpoint.
- An empty `statusTitle` falls back to the raw code so a sparse event still reads as
  something.
- At most 20 events are returned, newest first.
- `JJD`/`JD` + 16 digits and bare 24-digit numbers are low confidence: `JJD` collides with
  DHL and needs a domain hint or an explicit pick.
- Each event keeps its place, a town or hub with its country. A delivered parcel keeps
  its delivery time, and the destination country is kept; the origin country is not.
- Recipient name, address, phone and signature fields are never read; a test asserts it.
- The separate keyless ShipX route is `GET https://api-shipx-pl.easypack24.net/v1/tracking/{number}`.
  Its [official schema](https://dokumentacja-inpost.atlassian.net/wiki/spaces/PL/pages/11731050)
  includes locker names and addresses in `custom_attributes.target_machine_detail`.
  `expected_flow` contains forecast stages, not completed scans or a delivery estimate.
  Its point is added only for the same whole identifier, with matching collection
  progress and a scan clock no older than the hub's. It must identify a locker or
  public pickup service. Delivered parcels require actual collection evidence;
  planned destinations, door deliveries and returns have no point. ShipX history
  never replaces hub history, and its absence or failure leaves that history usable.
  Recognition uses the hub alone.

## Limitations

- No delivery estimate. Pickup details depend on ShipX coverage and current
  collection evidence; the hub's place alone names only the town.

## Testing

`npm run test:carriers:live -- carriers/inpost`. The wrong-number check
needs no env vars; set `INPOST_DELIVERED_TRACKING_NUMBER` to also check a real delivered
parcel.
Set `INPOST_PICKUP_TRACKING_NUMBER` to also check a parcel ready for collection
or collected at a point.
