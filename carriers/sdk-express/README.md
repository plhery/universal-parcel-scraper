# SDK Express

Tracks shipments of SDK Express (斯德克, 斯德克（深圳）国际物流有限公司), a Shenzhen forwarder
whose site is sdk-express.cn and whose lines run to Russia, on its own tenant of the Hualei (华磊)
forwarder platform. The client is shared with [GZYL](../gzyl/README.md), whose README describes the
platform; this carrier keeps its host, its clock rule and its status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `8.129.105.101:8082`, the address of the site's tracking link, then, when the interface holds
   no row for the number, one POST of the same `documentCode` to the tracking page
   `trackIndex.htm`, which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or browser
is needed.

## Notes

- The platform's own rows name a processing centre on the land route through Khorgos, in Chinese,
  to the second on its Beijing clock. The map lists them with the city as an ellipsis, and the
  adapter shows them in English with the city as the row's place.
- The Russian courier's rows the tracker copies are in Russian and give their day alone, at
  midnight, so they keep a day and no instant. The adapter shows them in English. They name neither
  the courier nor its number, so the parcel is not handed on.
- `Принят в городе отправителя` is the courier taking the parcel in Moscow after the land route, so
  it reads as transit, not acceptance.
- The record's product name is the service name and its destination the destination country.

## Limitations

No delivery carrier, delivery estimate or weight.

## Numbers

The sample comes from a tracking directory's SDK Express page. It is in the UPU S10 layout with
China Post's suffix and a valid check digit, so postal detection claims it and recognition does
not ask SDK Express; selecting the carrier or following a link to its tracker reaches the adapter.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP on a
bare address, no portal link is published, and the canary checks 17TRACK instead.

## Testing

`SDK_EXPRESS_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/sdk-express`, with the number
set outside the repository. The unknown-number case asks for a string in no shape the tracker
issues, or `SDK_EXPRESS_UNKNOWN_NUMBER` when set.
