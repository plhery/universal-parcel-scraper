# Iberomail

Iberomail distributes mail and parcels in Portugal and abroad, and sends home the things guests leave
in hotels. Its tracker takes the waybill (carta de porte); a parcel abroad travels on a partner post
under an S10 number of its own.

## How it works

1. `direct`: asks `iberomail.com/TrackAndTrace/search.php?keyword=<number>&lang=en`, the search of the
   tracker that `iberomail.com/track-trace/<number>/` frames. It sends the page script's `X-Client-Key`,
   the same for every visitor. An empty list is not found.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more.

- The reply is a list of AfterShip-shaped trackings that the service finds by keyword. Only one whose
  `order_id` or `tracking_number` is the whole number asked counts, and two that differ name no
  shipment. `order_id` echoes the number as it was typed.
- `tracking_number` holds the partner's number when another network carries the parcel. It becomes the
  delivery tracking number, which lets the lookup ask that partner; the reply names no partner itself.

## Notes

- Every `tag` in the replies is null, so the rows are staged by their wording: the domestic network's
  Spanish rows, a partner post's English ones and Iberomail's own Portuguese and English steps.
- The rows carry no zone, and a parcel abroad is scanned in other countries' clocks, so they keep their
  wall clock and the Node lookup dates them from their place, else on Lisbon's clock.
- A record whose rows carry no clock is Iberomail's summary: its last step is the status, with no
  history.
- A delivery row is followed by the signatory's id and name, which the adapter leaves out.
- The tracker page hides carrier names in the messages, from a list it loads; the adapter keeps the
  messages as the reply gives them.

## Limitations

- No delivery estimate, destination or proof of delivery.

## Numbers

Iberomail's waybills are W and six digits, too plain a shape for a detection rule. The samples and
their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/iberomail`

The live test tracks the first public sample in `numbers.json`; `IBEROMAIL_TRACKING_NUMBER` tracks
another number, and `IBEROMAIL_UNKNOWN_NUMBER` checks the not-found answer.
