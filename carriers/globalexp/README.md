# Global Express

Global Express (全球捷运国际快运有限公司) collects parcels in Hong Kong, trucks them to the Guangzhou border,
clears them into mainland China and hands them to ZTO for delivery. Tracked through the order page of its
site, global-express168.com, a FastAdmin site whose tracking plugin Quick Fort and JetSpeed also run.

## How it works

1. `direct`: one `GET https://www.global-express168.com/search_kuai_di/search/orderid/{number}`, the page the
   site's search box opens. It needs no cookie, token, account or browser. The server renders the order's rows
   in a table, newest first, and writes the number it answered for into the search box, which must be the
   whole number asked.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of the
   budget, so the retry fits in the rest.

- The site answers HTTP 500 to a request whose `Accept-Language` it cannot read, such as Node's `*`, so the
  adapter asks in Chinese.
- A number the site holds no order under gets its 温馨提示 notice, 未查询到对应订单, which does not repeat the
  number; that is not found. Another notice is inconclusive, and a page without the search box and the result
  block is a changed page.
- The orders page, `/cms/c/orders`, asks `/search_kuai_di/searchjson/orderid/{number}` for the same rows as
  JSON, which does not name the number.

## Notes

- The rows state no zone. They are dated on Hong Kong's clock with `carrier` as the basis: the firm writes its
  rows in Hong Kong and at the Guangzhou border, ZTO in mainland China, and both keep UTC+8 all year.
- The row 转国内中通快递，单号：… hands the parcel to ZTO. ZTO and that number become the delivery carrier and
  number when ZTO's rules take it; 中通快运 would name ZTO Freight. The destination is then China.
- The rows above that one are ZTO's sentences, copied with the courier's name and mobile, the branch's and
  complaint lines and the pickup point. The shared [`../zto/relayed.ts`](../zto/relayed.ts) keeps the sentence
  and takes the city it opens with as the place. The firm's own rows keep the place their brackets name.
- `statuses.json` writes the place in a sentence as `…`.

## Limitations

- No delivery estimate, weight, service name, sender or recipient.

## Numbers

Kuaidi100's example number is GX, twelve digits and JY, and its test number JY, twelve digits and GX: the
firm's initials, Global eXpress and 捷运 (Jieyun), around the digits. No other carrier's rule takes either
shape, so a low rule offers Global Express for both and recognition asks the page. The test number's order is
gone from the tracker, so it is kept as quarantined evidence. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/globalexp` tracks Kuaidi100's example number, or the number in
`GLOBALEXP_TRACKING_NUMBER`, and checks an invented number, or the one in `GLOBALEXP_UNKNOWN_NUMBER`, reads as
not found.
