# BEST Express Thailand

BEST Express Thailand parcels are read from the tracker on [best-inc.co.th](https://www.best-inc.co.th/track),
past BEST's picture verification.

BEST Express Thailand is the Thai parcel network of BEST Inc. It runs its own tracker at best-inc.co.th, on the
same build as BEST Express Malaysia's and BEST Express Vietnam's.

## Numbers

Archived lookups on the tracker show fourteen-digit waybills that start with 6685, Thailand's calling code and
85, as BEST Express Malaysia's start with 6085. `best-express-th-1` suggests BEST Express Thailand for this
prefix at low confidence: other carriers also print fourteen digits, and every example comes from the tracker's
archived addresses.

## Links

`best-inc.co.th/track?bills={number}` opens the tracker with the number filled in; the tracker also reads
`waybill`, and its mobile page, `/wapp/track`, takes either.

## Retrieval

The adapter is [BEST Express Vietnam's](../best-express-vn/README.md) with the Thai tracker's address and
verification key: the same verification service draws the same pictures, and the tracker answers in the same
shape. It asks for the scans in English, the first language the page offers, rather than Thai. A delivery's
scan names who signed before "POD".

## Testing

```sh
npx vitest run --config vitest.carriers-live.config.ts carriers/best-express-th/adapter.live.test.ts
```

The live test tracks a public sample in `numbers.json`; `BEST_EXPRESS_TH_TRACKING_NUMBER` tracks another
shipment.
