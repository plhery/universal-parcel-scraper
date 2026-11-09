# Western Bid

Reads Western Bid and WestParcel shipments through the public guest tracker and TRAWL.
The result must identify one WBX shipment and explicitly list the requested reference.
A complete USPS routing barcode can identify its package through the shared checksum
validator; arbitrary suffixes cannot establish an alias.

## Retrieval

The browser opens the whole-number link. The official client executes reCAPTCHA Enterprise
for action `TRACK` and calls its `currentStatus` endpoint with the verification header.
The adapter reads the rendered milestones because the service can omit an API capture body
whose size is unknown. A later captured refusal takes precedence over the rendered result.
Only the exact missing notice attached to the requested query establishes absence.

Reached, dated milestones retain the displayed wall clock and minute precision without a
guessed offset. Recipient details, external links and verification material are discarded.
The optional details view contains additional history, so the result stays partial and enabled
providers can supply a fuller timeline.

## Limitations

A configured TRAWL service is required. HTTP recognition does not open this browser flow.
Generic form errors and incomplete results remain inconclusive.

## Testing

```sh
FLARESOLVERR_URL=… WESTERN_BID_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/western-bid
```
