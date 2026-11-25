# Shilianxin

Tracks shipments of Shilianxin (世联鑫, 深圳市世联鑫国际物流有限公司), a Shenzhen cross-border
forwarder whose site is slxexp.com and whose US line hands parcels to USPS, on its own tenant of the
Hualei (华磊) forwarder platform. The client is shared with [GZYL](../gzyl/README.md), whose README
describes the platform; this carrier keeps its host, its clocks and its status map.

Its logo reads SLX, as does the Korean forwarder [SLX](../slx-kr/README.md), a different company:
the catalog names this one Shilianxin and gives it no `SLX` alias.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `47.108.154.213:8082`, whose `trackIndex.htm` the site's footer links to, then, when the
   interface holds no row for the number, one POST of the same `documentCode` to that page, which
   settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or browser
is needed.

## Notes

- The forwarder words its rows in Chinese, alone or before their English after a semicolon
  (`飞行到达；Flight arrived`). The English half is shown and staged; a Chinese row alone is shown
  in English. These rows are on the platform's Beijing clock.
- The rows the tracker copies from USPS are in English alone and keep the facility's wall clock,
  one at midnight its day alone. Places lose their ZIP code.
- The record's product name is the service name and its destination the destination country.

## Limitations

The record does not give USPS's number, so the parcel is not handed to USPS. USPS's rows keep their
wall clock without an instant. No delivery estimate or weight.

## Numbers

The sample comes from a tracking directory's Shilianxin page. No detection rule claims
Shilianxin's layout yet.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP on a
bare address, no portal link is published, and the canary checks 17TRACK instead.

## Testing

`SHILIANXIN_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/shilianxin`, with the number
set outside the repository. The unknown-number case asks for an invented number, or
`SHILIANXIN_UNKNOWN_NUMBER` when set.
