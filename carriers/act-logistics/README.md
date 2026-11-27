# ACT Logistics

ACT Logistics is a South African courier and road freight carrier with its head office in Cape
Town, branches in Johannesburg, Gqeberha and Durban, and subsidiary branches across the country. It
also sends documents and parcels abroad and runs cross-border road freight to neighbouring
countries. Its site is act-logistics.co.za. It tracks waybills through its
[ParcelPerfect tracker](https://actlogistics.pperfect.com/).

## How it works

1. `direct`: the adapter reads the public tenant code from `config/config.json` and asks the
   tenant's `Waybill.getEventData` service for one waybill, as the tracker does. Every visible scan
   must name that waybill. Clocks have no offset and are kept as local time.

[Bigfoot Express Freight](../bigfoot-express/README.md),
[Intertown Transport](../intertown-transport/README.md) and
[Primetime Express](../primetime-express/README.md) run the same tracker client, so the adapters
share `parcelPerfect.ts` and its reading of stages. The only not-found answer is the service's own
"Event data not found." for the waybill; any other error, a page or an incomplete reply is a
failure.

## Notes

- The tenant's waybills are digits followed by ACT, and the service finds a waybill only with that
  suffix. The adapter takes five to ten digits and the suffix. Detection names ACT Logistics for
  the public example's shape, seven digits and ACT, which no other carrier's rule or sample takes.
- `actlogistics.pperfect.com/?w=<waybill>` opens one waybill: the page stores the number and moves
  to its waybill view, whose address no longer holds it.

## Limitations

- The scans of a trunk route carry the hub the manifest goes to: a waybill loaded in Cape Town for
  Johannesburg is loaded and dispatched at "Johannesburg". The location is the hub the service
  gives.
- Only the waybill number is asked. The parcel's own tracking sticker number is a separate search
  on the tracker and is not read.
- The sender's and recipient's names, the proof-of-delivery image, the service, the piece count,
  the origin and destination hubs and the reference that the tracker's waybill view shows are not
  read.

## Testing

Set `ACT_LOGISTICS_TRACKING_NUMBER` and optionally `ACT_LOGISTICS_UNKNOWN_NUMBER` outside the
repository and run `npm run test:carriers:live -- carriers/act-logistics`.
