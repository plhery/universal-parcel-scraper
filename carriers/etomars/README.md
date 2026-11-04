# Etomars

The adapter reads SHIPNERGY registration histories for Etomars's Korea-to-Japan service through
plain HTTP. It binds the registration in both the result heading and shipment details, reads the
complete collapsed timeline and retains the carrier's local scan clocks. No offset is stated.

## Numbers

Registration numbers are SN, nine digits and JP. They resemble Japan Post's UPU S10 numbers,
but most fail its check digit. The existing low-confidence rule has HTTP recognition; a number
with a valid postal checksum keeps its postal detection. Detection alone establishes no shipment.
Order references and other service modes remain with enabled universal providers.

## Retrieval

`cbt.shipnergy.com/Track/Result` reads registration numbers through `mode=0` and `ids`. The
tracker keeps three months of records and returns the same empty view for expired and absent
registrations. That response remains inconclusive.

The destination delivery phase includes linehaul and storage. Its Japanese activity distinguishes
a delivery round from those scans. Order completion needs an explicit delivered activity before
it becomes delivery. The adapter projects known logistics activities and facilities; it omits
arbitrary free comments and the separate partner message box. A declared Sagawa handoff retains
its number for direct confirmation. A fast summary cannot replace the returned timeline.

## Links

Tracking links carry the registration number as `ids`, with `mode=0`. Other modes look up order
and delivery numbers.

## Testing

`ETOMARS_TRACKING_NUMBER` supplies a registration with retained history; `ETOMARS_UNKNOWN_NUMBER`
supplies a synthetic registration with no history:

```sh
npm run test:carriers:live -- carriers/etomars/adapter.live.test.ts
```
