# Sagawa Express

Catalog support for Sagawa's Japanese domestic parcels. Explicit carrier selection uses enabled universal providers, and the official tracking link is recognized.

## Retrieval

There is no dedicated adapter. The public tracking service rejects direct HTTP requests and submissions from the corporate site's current tracking form in an ordinary browser. Its access-denied page does not establish parcel absence.

## Limitations

Commercial universal providers are opt-in. Numeric waybills overlap other carriers, so their shape does not select Sagawa automatically. The Japan timezone is used only for local scan clocks attributed to this carrier.

## Testing

`SAGAWA_TRACKING_NUMBER=... npm run test:carriers:live -- carriers/sagawa`
