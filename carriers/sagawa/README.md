# Sagawa Express

Catalog support for Sagawa's Japanese domestic parcels. Explicit carrier selection uses enabled universal providers, and the official tracking link is recognized.

## Retrieval

There is no dedicated adapter. Sagawa has suspended its public shipment inquiry service and carrier inquiry API, as described in its [official service FAQ](https://www2.sagawa-exp.co.jp/information/detail/425/). Access denial does not establish parcel absence.

## Limitations

Commercial universal providers are opt-in. Numeric waybills overlap other carriers, so their shape does not select Sagawa automatically. The Japan timezone is used only for local scan clocks attributed to this carrier.

## Testing

`SAGAWA_TRACKING_NUMBER=... npm run test:carriers:live -- carriers/sagawa`
