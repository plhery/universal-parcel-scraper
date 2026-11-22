# Yuxin Logistics

Tracks Yuxin Logistics (宇鑫物流), a less-than-truckload freight network based in Shandong,
through the waybill search on its own site.

## How it works

The site answers on plain HTTP only. `direct` fetches
`http://www.yx56.cn/servlet/validateCodeServlet` with the tracking page as referrer; the picture
opens the session that holds its code. The shared text model in
`core/transport/text-captcha-worker.mjs` reads its four letters and digits, and the adapter posts
`orders` and `req_pic_key` to `http://www.yx56.cn/ix/cms/tFlow/queryExpressOrders`, as the page's
script does. A wrong reading comes back as "验证码不匹配", and the adapter tries a new picture, up
to three. A reading that is not four letters or digits is not sent.

The reply holds the waybill's scans and its order. Scans keep `operateDate` as a China wall
clock and `operateTypeName` as their code, and are worded as the page words them from the
branches they name. The page reads an unloading scan (落地) as an arrival at the next branch,
and says whether every piece arrived on the newest one. The order names the shipper and the
consignee with their phones and addresses; the adapter reads only its waybill number and
whether it is signed for, and never the staff who scanned.

## Limitations

The tracker counts every answer towards a limit on quick lookups and then answers
"请求太快" (rate limited) for a while. Waybills are ten digits, a shape many carriers share, so
the carrier is never detected and needs explicit selection. With no HTTPS page, no portal link
is published and the canary checks 17TRACK.

## Testing

`YUXIN_LOGISTICS_TRACKING_NUMBER=… YUXIN_LOGISTICS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/yuxin-logistics`
