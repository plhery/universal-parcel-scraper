# Yaoqi Logistics

Tracks Yaoqi Logistics (耀奇物流), a Shenzhen freight network shipping across China, through the
EMMIS tracking page its site's tracking box opens.

## How it works

`direct` posts `w=szyqi&cno=<waybill>` to `http://www.yaoqi56.com/cgi-bin/GInfo.dll?EmmisTrack`,
as the box on `http://www.yaoqi56.com/` does, with no session, captcha or account. `szyqi` is the
site's account on the EMMIS server, the same for every visitor. The site answers over HTTP only,
and this server does not offer the EMMIS structured API other carriers' servers do. A request that
fails to reach the server gets one `retry` in the rest of the budget.

The page is GB2312. Its header names the waybill, which must be the whole number asked, then the
scans follow, oldest first, on China wall clocks to the minute. A row has no scan code, so the
adapter names it after the phrase its wording is built around, such as 已到达 or 正在派件. A
row's place is the scanning site followed in brackets by the previous or next site; the adapter
keeps the scanning site as the location. The courier's name and phone numbers are removed.

## Limitations

Waybills are twelve digits, a shape many Chinese carriers share, so the carrier is never detected
and needs explicit selection. The header's origin, destination, piece count and delivery time are
left out; the delivery time is the signing row's clock.

## Testing

`YAOQI_LOGISTICS_TRACKING_NUMBER=… YAOQI_LOGISTICS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/yaoqi-logistics`
