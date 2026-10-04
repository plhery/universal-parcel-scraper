# CNE Express

Catalog support for CNE cross-border shipments. Explicit carrier selection uses enabled universal providers, and the official tracking link is recognized.

## Retrieval

There is no dedicated adapter. The public website signs its tracking requests with a WebAssembly client and rejects automated lookups. An empty or rejected direct reply does not establish parcel absence.

## Limitations

Commercial universal providers are opt-in. A number's unverified shape does not select CNE automatically. Provider clocks and delivery-partner evidence retain the provider's own semantics.

## Testing

`CNE_TRACKING_NUMBER=... npm run test:carriers:live -- carriers/cne`
