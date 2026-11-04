# Royale International

The adapter reads Royale International's server-rendered guest tracking page. It binds the
whole prefilled waybill and the unique shipment, event and proof tables. Twelve digits alone
establish no carrier ownership, so explicit selection and tracking links reach the adapter
without a broad numeric detection rule.

`www.royaleinternational.com/tracking?waybillno={number}` needs no account or session. An empty
search view remains inconclusive. Changed markup and verification failures stay distinct;
enabled universal providers remain available for fallback.

The page lists updates oldest first. The adapter reverses that sequence without assigning a
home time zone to overseas scans. A dated proof supplies a delivery event; its separate POD
capture update is administrative. The proof must have a same-day capture context to place it
in the history. POD capture alone does not prove delivery. The latest update clock can therefore
be later than the physical delivery clock.

Recipient, shipper, reference, signature and proof-detail cells are omitted. Only explicit
facility scans provide locations; a facility the parcel is travelling toward does not.

## Testing

Supply `ROYALE_INTERNATIONAL_TRACKING_NUMBER` and `ROYALE_INTERNATIONAL_UNKNOWN_NUMBER` privately:

```sh
npm run test:carriers:live -- carriers/royale-international/adapter.live.test.ts
```
