# China United Lines

Use the [CU Lines cargo tracking page](https://www.culines.com/en/site/bill) and select China United Lines explicitly. Enter an 11-character container number.

## Retrieval

The adapter follows the public container lookup and then opens its cargo movements. It requires one booking from the first request and checks that every movement refers to its cargo detail reference. A container can appear on multiple sailings, and the result describes the booking available from CU Lines for the requested equipment at lookup time.

The adapter keeps movements marked actual and records port or city text and the local clocks printed by the carrier. Empty equipment movements stay in the history without changing the shipment stage. Terminal gate-out can represent a port shuttle, so it stays in transit.

## Testing

`CHINA_UNITED_LINES_TRACKING_NUMBER=… CHINA_UNITED_LINES_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/china-united-lines`
