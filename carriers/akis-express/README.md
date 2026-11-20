# AKIS Express

Tracks domestic shipments from the Cypriot courier G.A.P. Akis Express.

## Retrieval

The tracking page posts the number to the site's WordPress AJAX action
`tracking_show_table`. The reply contains an HTML table headed by the requested
number. The same table with only its empty row means the number is unknown.

The tracker shows each scan's local clock and station. Scan wording stays in Greek
as supplied. The adapter reads the public history and leaves the remarks out.

## Numbers

Select AKIS Express explicitly or open a carrier link with the `tracking_num`
parameter.

## Testing

`AKIS_EXPRESS_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/akis-express`
