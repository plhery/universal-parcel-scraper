# Disu Logistics

Tracks Disu Logistics (D速物流, 山东递速物流有限公司), a Shandong parcel network delivering across
China, through the tracking box on its own site.

## How it works

The box on `http://www.d-exp.cn/` checks the waybill with the site's own script
(`/js2/TraceInfo.js`) and posts to `http://www.d-exp.cn/Home/TraceinfoQuery?billcode=<waybill>`
with an empty body. `direct` sends the same request with no session, captcha or account; the IIS
server refuses a POST without a length, so the body is empty rather than absent. The site answers
over HTTP only. A request that fails to reach the server gets one `retry` in the rest of the
budget.

The reply is an HTML fragment: a heading naming the waybill, then its scans newest first on China
wall clocks. The heading must name the whole waybill asked; an unknown waybill comes back with the
heading and no scans. A row's leading bracket is its place, the city of a 省-市 pair or a transfer
centre, and its scan is matched from the wording. The wording leaves out the customer service
notices, the courier's name and phones, the signatory and other phone numbers. A pickup point and
the delivering partner's waybill (代派单号) stay; the newest such waybill is also the result's
`delivery_tracking_number`.

A redelivery at the recipient's request (再次派送) is a failed attempt.

## Limitations

The script accepts twelve digits, 6 and fourteen digits, or DS and fifteen digits. Public waybills
are twelve digits, a shape other carriers share, so the carrier is never detected and needs
explicit selection. The delivering partner's own tracking is not followed.

## Testing

`DISU_LOGISTICS_TRACKING_NUMBER=… DISU_LOGISTICS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/disu-logistics`
