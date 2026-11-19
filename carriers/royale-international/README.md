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
capture update is administrative. The nearest capture within the following 24 hours anchors the proof
in the history, including across midnight. POD capture alone does not prove delivery. The latest update clock can therefore
be later than the physical delivery clock.

The consignee becomes the receiver, and the dated proof row's recipient the signer once the
parcel is delivered. An update keeps its whole wording; its stage is read from the wording
before a link, a recipient or a phone number. The shipper, reference, signature and proof-detail
cells are not read. Only explicit facility scans provide locations; a facility the parcel is
travelling toward does not.

## Testing

Supply `ROYALE_INTERNATIONAL_TRACKING_NUMBER` and `ROYALE_INTERNATIONAL_UNKNOWN_NUMBER` privately:

```sh
npm run test:carriers:live -- carriers/royale-international/adapter.live.test.ts
```
