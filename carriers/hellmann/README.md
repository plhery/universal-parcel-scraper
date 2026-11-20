# Hellmann Worldwide Logistics

The adapter reads the anonymous road-package summary from Hellmann's [public tracker](https://www.hellmann.com/en/track-trace). It submits a twenty-digit NVE package reference to `/public/api/v1/road/search` on `public-road.tracking.hellmann.net` and requires that whole reference in the returned package list.

Only single-package replies are used, so the shipment status and clock belong to the requested package. Multi-package summaries remain inconclusive, and a conflicting per-package status is rejected. The response supplies a current status and last-change clock, without a scan history. Results are marked `summary_only` so enabled providers can supply richer history. Offset-free clocks retain their wall time. The SDK may date the summary using the carrier’s catalog zone; the native field itself supplies no zone. No delivery scan or delivery instant is inferred. An NVE names its issuer, so its shape does not establish Hellmann ownership.

Shipment-number, air and sea searches are outside this adapter's scope. The separate postcode verification unlocks additional data and is not called. Generic API errors are not finalized as missing shipments. Other road states remain unresolved until their milestone meaning is verified.

## Testing

```sh
HELLMANN_NUMBER=… npm run test:live -- carriers/hellmann/adapter.live.test.ts
```
