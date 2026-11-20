# Cargo X

Cargo X is an e-commerce parcel carrier in Turkey. Earlier Scotty courier parcels use
[Kargoist](../kargoist/README.md). Select Cargo X explicitly to track a merchant's shipment number.

## Retrieval

The [public form](https://www.cargox.com.tr/) sends the shipment number as a barcode
to the Cargo X tracking host. The adapter follows one redirect on that host and requires
the shipment page and the piece history to name the requested number. The tracking host's
shipment-not-found page identifies an unknown number.

The scan table gives Turkish status wordings, branch names and local clocks in Turkey's
time zone. The adapter reads the history for the matching piece. A shipment with separate
piece numbers can be tracked using the number on each piece.

## Testing

`CARGOX_TRACKING_NUMBER=… CARGOX_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/cargox`
