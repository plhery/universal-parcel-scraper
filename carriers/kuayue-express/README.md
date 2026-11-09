# Kuayue Express

Kuayue Express parcels use enabled universal providers. There is no dedicated adapter.

Kuayue Express (跨越速运, KYE) is a Chinese time-definite express carrier based in Shenzhen,
majority owned by JD Logistics. Its site is ky-express.com.

## Numbers

Its waybills read `KY` and thirteen digits, a layout its own tracker's validation lists and
public posts show. Older waybills of eleven or seven digits share their lengths with many carriers,
so they have no rule.

## Why there is no adapter

The official mobile guest client first calls `web.query.waybill.getVisitorAuthToken`
at `https://api.ky-express.com/router/rest`. It sends the whole waybill, a fresh
visitor session id and a source marker, then receives a verification mode and token.
`web.query.waybill.officialMobileRoute` sends the whole waybill and `captchaParam`
with the native Tencent ticket and verification state. A recipient-phone branch is
a separate input requirement.

The framed desktop client uses its own `u.ky-express.com/router/rest` gateway.
`web.query.waybill.officialRoute` sends `waybillNumber` as a one-item array,
and its visitor bootstrap uses source `10`. These contracts differ from the
mobile page's scalar waybill and source `30`. The frame's Tencent constructor
belongs to the page context; an isolated evaluation world need not expose it.

The customer Android package is `com.oxbix.spanlogistics`. Its protected business
code has not established a simpler guest tracking API. The operations and driver
apps are separate from customer guest tracking.

## Links

The tracker opens waybills from the `orders` parameter of its search page at `/88.html` or `/website/88.html` on www.ky-express.com
and of the frame it loads from u.ky-express.com, and its mobile route page from `waybillNo` in
its address's fragment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
