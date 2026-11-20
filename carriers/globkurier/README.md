# GlobKurier

[GlobKurier](https://www.globkurier.pl/faq-twoja-przesylka) books parcels and freight in Poland and issues a `GK` shipment reference for the booking. Select **GlobKurier** with that reference.

## How it works

The public tracking application sends one `GET` to `https://api.globkurier.pl/v1/order/tracking` with `orderNumber`. The adapter uses the same guest request and reads the latest status and history. The API does not echo the GK reference at the top level. The adapter binds the response to its exact request and does not follow redirects.

The summary and history can repeat the same event; it appears once in the result. Scan clocks have no offset. The adapter preserves those wall-clock times and omits the booking's address fields.

## Testing

`GLOBKURIER_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/globkurier`
