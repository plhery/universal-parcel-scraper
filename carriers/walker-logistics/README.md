# Walker Logistics

Walker Logistics is a New Zealand courier and freight company in Auckland and Christchurch.

## Retrieval

The carrier's Tempo tracker reads a guest JSON endpoint on its own host. The adapter uses
the same endpoint and requires both the echoed search and the consignment number to match.
A response that echoes the search and explicitly reports no item or consignment is not found.
Piece-only matches are inconclusive.

Scans keep their stated offset. The adapter reads the event type, outcome, reason and location.
A delivery event only sets the delivered stage when its outcome is successful. A step whose
outcome is not successful is staged by the shared wording rules on its step, outcome and reason,
so a failed delivery reads as an attempt; a pickup or manifest that did not succeed is the
sender's side and has no stage.

## Testing

`WALKER_LOGISTICS_TRACKING_NUMBER=… WALKER_LOGISTICS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/walker-logistics`
