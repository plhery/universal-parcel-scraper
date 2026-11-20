# Tramaco Express

The adapter reads the Ecuadorian carrier's anonymous JSON endpoint, used by its [guest tracker](https://www.tramaco.com.ec/rastreo.html). It submits one guide to `/apis/tracking_web.php?campo=guia&valor=…` and requires the same whole guide in `transaccion.guia` before accepting history.

The native client omits contract-document container entries and route bookkeeping from parcel milestones. The adapter follows that selection, so a later document entry does not undo delivery. Delivery wording is kept without its appended signer or identity value. Sender, recipient, map coordinates and delivery documents are not extracted.

The adapter keeps minute scans as offset-free local clocks. The SDK may date the summary using the carrier's catalog zone; the native scans state no zone. No delivery instant is inferred. A specific, whole-guide-bound JSON missing notice is a negative result even though the endpoint returns HTTP 502 for it; other 502 replies stay transport failures. Unsupported milestones and empty histories remain inconclusive, preserving provider fallback.

No login, phone input or API key is required. Number shape alone establishes no carrier ownership.

## Testing

```sh
TRAMACO_NUMBER=… npm run test:live -- carriers/tramaco/adapter.live.test.ts
```
