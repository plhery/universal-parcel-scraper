# Huaqi Express

Tracks Huaqi Express (华企快运), a Shanghai network delivering to shops in shopping districts
across China, through the waybill tracking page on its site.

## How it works

`direct` fetches `https://www.huaqiex.com/tracking?orderNumbers=<waybill>`, the page the site's
search box opens, with no session, captcha or account. The page renders a panel titled with the
waybill, which must be the whole number asked, holding its scans newest first on China wall
clocks; an empty panel is a waybill the site does not know. A request that fails to reach the
server gets one `retry` in the rest of the budget.

Huaqi hands the long-distance leg to a partner network, whose hub and store scans appear in the
same list. A row has no scan code, so the adapter names it after the phrase its wording is built
around, such as 已收件 or 快件到达, and takes the bracketed site of a branch or hub scan as its
location. The scanner, the courier's name and phone and the courtesy lines are removed.

## Limitations

Waybills are twelve digits, a shape many Chinese carriers share, so the carrier is never detected
and needs explicit selection. Progress notes such as a courier being assigned have no stage.

## Testing

`HUAQI_EXPRESS_TRACKING_NUMBER=… HUAQI_EXPRESS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/huaqi-express`
