# Sea Legend Line

Select Sea Legend Line explicitly and enter an equipment number in the [cargo tracker](https://www.slg-shipping.com/#/home/tracking).

## Retrieval

The adapter submits the number to the guest cargo lookup and reads only the matching container. The website also offers bill searches. Its bill response can omit the submitted reference, so the adapter supports containers whose numbers the result confirms.

The history uses the recorded movement clocks and terminal labels from the English tracking page. The gateway can repeat the same events. The adapter keeps each movement code at each recorded time and port once. Empty return stays in the history without implying parcel delivery. Estimates are omitted.

## Testing

`SEA_LEGEND_LINE_TRACKING_NUMBER=… SEA_LEGEND_LINE_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/sea-legend-line`
