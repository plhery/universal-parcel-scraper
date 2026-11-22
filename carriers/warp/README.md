# WARP

WARP runs freight across the United States, from full truckloads to pallets moved through its own
cross-docks. Its tracking page, `tracking.wearewarp.com`, takes a shipment number (S-) or the
number of the order holding it (P-).

## How it works

1. `direct`: asks `gw.wearewarp.com/api-tracking/{number}?fe=true`, the reply the tracking page
   builds from; `fe=true` adds the events' titles. An unknown number gets an empty 404, so the
   adapter then asks `gw.wearewarp.com/api/v1/p/tracking/{number}/stops`, the stops service of
   the page's map, and reads its 400 `Code not found` as not found.
2. `retry`: a read that fails to reach WARP, or hangs, is sent once more.

- Neither service asks for a session, a key or a check.
- The number goes with its hyphens, as WARP writes it: the last four digits are the year and week,
  so a number typed without hyphens gets them back.
- The reply must name the number as its order's or one of its shipments'. An order holding several
  shipments names none of them; each is tracked by its own number.

## Notes

- Events carry epoch milliseconds, which stay instants. An event at a stop names the stop's town.
- The codes come from the tracking page's script, which groups the events into phases. A
  cross-dock departure titled "Out for delivery" is the last leg. Appointment notices get no
  stage, as the page files them apart from the shipment's progress.
- The headline follows the page: a delivered, canceled or returned shipment by its status,
  otherwise the further along of its status and its newest event.
- The delivery window is the drop-off's, given only while the shipment is under way.
- The customer, the stops' names, streets, references, coordinates, weight and proofs of delivery
  are left out.

## Limitations

- No proof of delivery or live truck position.

## Numbers

The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/warp`

The live test tracks the delivered public sample in `numbers.json` and checks the not-found
answer; `WARP_TRACKING_NUMBER` tracks another number and `WARP_UNKNOWN_NUMBER` checks another
unknown one.
