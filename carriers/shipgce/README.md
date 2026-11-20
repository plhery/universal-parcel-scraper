# Feiyang GCEx

Feiyang GCEx (飛洋轉運) ships parcels from the United States to mainland China, Hong Kong and Taiwan.

## Retrieval

The express tracker serves a public HTML result at `express.shipgce.com/postcheck.htm` with
`checkvalue` and `type=identity`. The adapter looks up one waybill and requires the result to
repeat it. It requests the English page, which has a distinct message for an unknown waybill.

The page mixes GCEx and postal scans. The adapter keeps their page order and wall clocks
because the page gives no offsets. A scan's location and wording can run together in one
field, which the adapter keeps intact.

## Limitations

Select Feiyang GCEx or open one of its express tracking links. The adapter reads express
waybills and uses the order-number tab of the tracker.

## Testing

`SHIPGCE_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/shipgce`
