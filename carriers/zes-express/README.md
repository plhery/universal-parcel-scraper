# ZES Express

ZES Express is the brand of Eshun International Logistics (俄顺国际物流), a Yiwu
forwarder carrying e-commerce parcels from China to Russia through onward networks.

## Retrieval

The [official site](https://www.zes-express.com/) links to `track_query.aspx` on
the plain-HTTP tenant `120.26.82.200:8080`. The dedicated adapter reads that tenant's
guest `/webservice/Service.ashx` using the [RTB56 protocol](../yypost/rtb56.ts),
without a session or browser. HTTP recognition confirms the whole forwarding waybill
before the ordinary native history lookup. The page's slider is separate from this guest API.

The tenant can resolve a merchant reference to another shipment. The adapter accepts
ZES forwarding waybills only and requires the whole returned `server_hawbcode` to
match. A merchant echo in `shipper_hawbcode` is insufficient. Its confirmed scope is
Russia-bound ZES parcels; shared-platform branding does not expand that scope.

The reply includes ESHUN warehouse scans and relayed Russian delivery scans. Offsets
explicitly stated by the carrier are preserved, even where the facility label suggests
another zone; rows without one retain their wall clocks. Summary closure does not
establish delivery. Only dated scan wording supplies stages. An explicit onward
reference is retained without assuming every parcel goes to CDEK. Signatories,
explicit recipient/signature suffixes in Russian wording and proof-of-delivery
fields are omitted. No document request is made.

## Links

The browser page uses a slider and a plain-HTTP bare IP address, so no parcel link
is published. A standalone CDEK waybill belongs with [CDEK](../cdek/README.md).

## Testing

`ZES_EXPRESS_TRACKING_NUMBER=… ZES_EXPRESS_UNKNOWN_NUMBER=… npm run test:live -- carriers/zes-express/adapter.live.test.ts`
