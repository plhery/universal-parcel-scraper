# KEC eCommerce

The native adapter tracks KEC eCommerce's cross-border parcels through its public guest feed.
KEC, formerly Kerry eCommerce, is separate from [KEX Express](../kex-express-hk/README.md).

## Retrieval

The [official guest widget](https://kec.kln.com/en/logistics-tracking/) sends a GET to
`https://tt.kec-app.com/api/status` with `tracking_number` and a fixed authorization value it
gives every visitor. The adapter uses that same request without an account or browser. A network
failure can retry once within the lookup budget; HTTP errors and invalid replies do not retry.

The returned whole number must match the request. Each scan keeps `event_date` with its stated
`timezone` offset; `timezone_date` is the UTC copy, checked when present. Stages use the observed
code and wording together because delivery-attempt categories can contain depot sorting.

## Limitations

Unknown numbers and service faults share HTTP 500, which remains inconclusive. Empty histories
also remain inconclusive. Responses beyond the retained scan limit are marked partial so enabled
providers can supply a fuller history.

Tracking uses an explicit carrier or a recognized KEC link. The feed accepts uploaded shipper
numbers, including YunExpress references, which stay with [YunExpress](../yunexpress/README.md)
in detection. KEC's older own format has no confirmed current history and gains no number rule.

## Testing

Use private inputs outside Git:

```sh
KEC_ECOMMERCE_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/kec-ecommerce
```

`KEC_ECOMMERCE_UNKNOWN_NUMBER` optionally checks the inconclusive unknown response.
