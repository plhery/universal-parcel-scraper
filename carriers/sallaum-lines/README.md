# Sallaum Lines

Select Sallaum Lines and enter the 17-character VIN. The adapter uses the carrier’s anonymous Logisoft tracker and verifies the full serial returned by its Sallaum Lines tenant. [Official tracker](https://sallaumlines.com/track-shipment/)

The adapter keeps the dated intake, vessel shipment and discharge records. It preserves day precision for midnight placeholders and local clock precision for timed records. The public page labels its discharge summary “Unit delivered at destination”. The event is a vessel discharge, so the adapter records it as a port movement. It omits vehicle model, vessel and voyage references.

```sh
SALLAUM_LINES_TRACKING_NUMBER=… SALLAUM_LINES_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/sallaum-lines
```
