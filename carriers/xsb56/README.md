# Xinshengbang Logistics

Xinshengbang Logistics (鑫圣邦物流, 深圳市鑫圣邦物流有限公司) is a road freight firm in Shenzhen with lines from
Shenzhen across China. Its site is xsb56.cn, a site template of Lanqiao's TMS (蓝桥, lqfast.com) that shows the
firm's waybills itself.

## How it works

1. `direct`: one `GET http://www.xsb56.cn/Tracking_….shtml`, the page the site's search box opens for a
   waybill or cargo number. No session, cookie, account or browser.
2. `retry`: the same request once more when the first fails to reach the site or hangs.

The page names the number it answers about (`lblNum`), then a table of rows, oldest first, each a serial, a
wall clock and a sentence. An unknown number gets the table's header with no row, read as not found. A page
about another number is indeterminate; a page without the number or the table is a changed page.

## Notes

- Rows keep their wall clock as `local_time` and are dated on China's clock with `carrier` as the basis.
- The table can list a transfer enquiry phone as a row of its own (中转查询电话:), with no clock; it is not a
  scan and is left out. Contacts inside a row are dropped as the shared Lanqiao reader in
  [`../anjiexin56/lqfast.ts`](../anjiexin56/lqfast.ts) drops them.
- A row that starts with a city and a branch (深圳(深圳)已开单入库) gives them as its location.
- The wordings are staged by `statuses.json` through the Lanqiao status helper; others fall to the shared
  wording rules.
- The site is plain HTTP only.

## Limitations

No delivery estimate, weight, piece count or proof of delivery: the page shows the rows alone.

## Numbers

The public example is eight digits, a shape many carriers share, so there is no detection rule and no
recognition: a lookup asks Xinshengbang only when the user picks it. A pasted tracking page link names the
number.

## Testing

`npm run test:carriers:live -- carriers/xsb56` reads the public sample, or `XSB56_TRACKING_NUMBER`.
