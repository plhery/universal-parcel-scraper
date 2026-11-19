# Intertown Transport

Intertown Transport (ITT) tracks its eight-digit waybills through its
[ParcelPerfect tracker](https://intertown.pperfect.com/). Select the carrier explicitly.

The adapter reads the public tenant configuration and calls the tenant's waybill event service.
Each event must repeat the whole waybill. The service returns the history oldest first, with
facility names and local clocks. Its explicit empty event reply means no tracking record.
Stages are read as [Bigfoot Express Freight](../bigfoot-express/README.md) reads them on the same
tracker.
The all-zero value is excluded because the service returns placeholder events for it.

The tracker holds the waybill in browser storage, so there is no direct link to a waybill.

Set `INTERTOWN_TRANSPORT_TRACKING_NUMBER` and optionally `INTERTOWN_TRANSPORT_UNKNOWN_NUMBER`
outside the repository and run `npm run test:carriers:live -- carriers/intertown-transport`.
