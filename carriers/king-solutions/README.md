# King Solutions

King Solutions is a third-party logistics company in Dayton, Minnesota. It manages truckload and
less-than-truckload freight, consolidates shipments, delivers the final mile and enters mail at
USPS destination facilities. It gives shipments its own King pro numbers. Its site is
kingsolutionsglobal.com.

## Numbers

The only public example is SO, nine digits and SO, from an aggregator, so there is no rule.

## Retrieval

The guest page looks up one or more PRO numbers through KingREST. The adapter requests one and checks the matched King or carrier PRO against the shipment record. The shipment status and actual delivery date come from the summary. Dated external notes are kept in time order, including dispatch updates entered after delivery. The fixture is the KingREST reply for the public example in `numbers.json`.

## Testing

`KING_SOLUTIONS_TRACKING_NUMBER=… KING_SOLUTIONS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/king-solutions`
