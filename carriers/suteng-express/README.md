# Suteng Express

Tracks Suteng Express (速腾快递), a Guangdong express network centred on its Humen hub in
Dongguan, through the waybill tracker its site opens.

## How it works

`direct` fetches `http://106.55.23.231:8082/SearchScanInfoInterface/searchCode.do?billcode=<waybill>`,
the page the waybill box on `https://www.ste56.com/` opens, with no session, captcha or account.
The tracker answers on that address only and over HTTP; the site's domains do not serve it. A
request that fails to reach the server gets one `retry` in the rest of the budget.

The page is GB2312. Its header row names the waybill, which must be the whole number asked,
then the scans follow, oldest first, on China wall clocks. A row has no scan code, so the adapter
names it after the fixed phrase its wording is built around, such as 已收件 or 装车. Rows give
branch and courier phone numbers, the courier's name and the signatory; the adapter removes them
and keeps the branch names. The branch a row names after its city is the event's location.

## Limitations

Waybills are twelve digits, a shape many Chinese carriers share, so the carrier is never
detected and needs explicit selection. The header's origin and destination branches, pieces and
signing remark are left out.

## Testing

`SUTENG_EXPRESS_TRACKING_NUMBER=… SUTENG_EXPRESS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/suteng-express`
