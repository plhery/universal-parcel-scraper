# Booth's Logistics

Booth's Logistics (Booths Transport) carries general freight and containers between its depots
across New Zealand, for business customers who book jobs in its B CONNECTED portal. Its public
track and trace takes a consignment number.

## How it works

1. `direct`: asks `ConsignmentTrack/ReferenceSearch?reference=` on `portal.booths.co.nz`, the
   search the tracking results page runs, then `ConsignmentTrack/{id}?containerId=` for the
   consignment it lists, as the details page does. An empty search is not found.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more.

- Both requests carry the `Api-Key` header the results page gives every visitor in
  `trackTraceAjax.api_key`. The adapter keeps that shared key; when the service refuses it, it
  reads the key from the results page again.
- The search also takes a customer's pickup, order or delivery reference and lists every
  consignment under it. Only a consignment whose own number is the one asked answers it.

## Notes

- The history shows the milestones alone, each code once per place, as the tracker does. A
  milestone's place is the first place it names.
- Each event gives its wall clock and its UTC time. The offset between them is kept where it is
  New Zealand's at that instant; otherwise the event keeps its wall clock.
- The status is the job's own; when its wording is not mapped, the newest staged milestone sets
  the stage. A cancelled job is an exception.
- Origin and destination are addresses, so they stay behind with the weights, volumes and the
  container's details.

## Limitations

- No delivery estimate.
- Codes and wordings beyond the public sample's come from the tracker's script and Booth's guides.

## Numbers

Booth's system numbers a job, and customers can give their own consignment numbers. The samples
and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/booths-logistics`

The live test tracks the public sample in `numbers.json`; `BOOTHS_LOGISTICS_TRACKING_NUMBER`
tracks another consignment, and `BOOTHS_LOGISTICS_UNKNOWN_NUMBER` checks the not-found answer.
