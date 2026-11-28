# Ks2Home

Ks2Home ships parcels from Germany to China: its warehouse near Munich packs them, flies them from
Frankfurt and has them cleared in China, where a domestic courier delivers them. Its site serves a
waybill page with the firm's own rows.

## How it works

1. `direct`: one `GET http://www.ks2home.de/express/query/?code=<number>`, the page the site's form
   opens, which the server renders with the rows. The site has no HTTPS.
2. `retry`: one more try when the request fails to reach the site or hangs.

- The heading 单号 <number> 的查询结果 must name the number asked; 单号不存在 is the answer for an
  unknown number. A bot-check page and HTTP 403 are challenges.

## Notes

- A row is a heading with a place in 【】 and a line under it; the place is the location and the
  description joins the two, as `statuses.json` lists them.
- Rows keep their wall clock alone. The page names no zone, and its German and Chinese rows may share
  one clock.
- The site has no HTTPS address, so the catalog gives no link to its page, which the apps could not
  open, and the canary probes 17TRACK. A pasted link to the page still reads as Ks2Home's.

## Limitations

- The firm's rows end at import clearance. The domestic courier's name, its waybill and its rows come
  from a relay the page asks once it has loaded, which is not read, so a parcel stays in customs here.

## Numbers

The waybill numbers seen are DE and ten digits, the first six the date: Amazon Logistics' shape for
its German tracking ids, which its rule claims. The adapter answers explicit selection. The samples
and their sources are in [`numbers.json`](numbers.json).

## Testing

`KS2HOME_TRACKING_NUMBER=… KS2HOME_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/ks2home`
