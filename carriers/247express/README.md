# 247Express

247Express parcels use enabled universal providers. There is no dedicated adapter.

247Express (Công ty Cổ phần Hai Bốn Bảy) is a Vietnamese express courier for businesses, with
its own post offices, carrying documents and goods within Vietnam and abroad.

## Numbers

247Express prints numeric waybills. The tracking box on its home page gives eleven-digit
examples. Eleven digits are a shape other carriers' rules also read, so no rule claims them.

## Retrieval

The [official Android app](https://play.google.com/store/apps/details?id=com.holdings.a247express)
offers guest multi-tracking at
`GET https://tracking-webkh.247express.vn/api/Tracking/MobileTrackingMulti/{wholeWaybill}`
with shared app headers. It is separate from the recipient-phone detail flow. An empty
`orders` list supplies no shipment identity or dated history, so it does not establish absence.
The [business tracking API](https://apidoc.247express.vn/english-1.0.6/tracking) instead requires
a customer-issued API key and source-IP access.

## Links

`247express.vn/tra-cuu-van-don/{number}` opens one or more waybills, separated by commas. The
site's tracker builds that address.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
