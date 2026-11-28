# Tuxing Supply Chain

Tuxing Supply Chain (途兴供应链, zgtux.com), in Foshan, carries retail firms' parcels in China, such as returns
from their stores and transfers between them, and sends them by JD Logistics or Deppon. Tracked through the routes page its home
page's box opens.

## How it works

1. `direct`: one `GET https://vip.zgtux.com/routes?no={number}`, the page the home page's box opens. It renders
   the waybill's route on the server, UTF-8, and needs no cookie, token or account.
2. `retry`: one more request when the first fails to reach the page or hangs. The first gets half of the budget.

- The page heads its answer with `运单号：<number>`. The single line 查无相关路由信息 under the number asked is the
  tracker's only answer for a waybill it does not know. Only that is not found. A heading for another number is
  refused, a page without the heading that says 请求过于频繁 is rate limited (the server answers so, with HTTP 200,
  a request that follows another too closely), any other page without it has changed, and any other status is a
  moved page or a request the site refuses.

## Notes

- The firm's own rows and the rows it relays from JD Logistics or Deppon are on China's clock, to the minute, with
  `carrier` as the basis. A clock that would date a row after the lookup keeps its wall clock alone.
- The relayed rows name couriers with their phones, the branches' phones and the courier's courtesy lines. A
  courier named with a phone, a bracket that holds a phone or a contact, a person after their role, and each row
  from its first clause that gives a phone, asks the reader to call or follows the news with a courtesy are left
  out, with the same reader as [JDX Express](../jdxexpress/flowlink.ts)'s, and so is anything after the row's first
  sentence.
- The page does not show the JD Logistics or Deppon waybill, so there is no delivery carrier or delivery number.
- `statuses.json` records each text the firm and the two couriers wrote with its stage.

## Limitations

- No delivery estimate, weight, service name, location, sender or recipient.

## Numbers

Tuxing's waybills seen so far are TX and nine digits, a shape GLS Italy's rule takes for two letters and nine
digits, so detection does not name Tuxing, and the adapter answers explicit selection for any number of 6 to 30
letters and digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`vip.zgtux.com/routes?no={number}` opens the waybill's route. The search page is the same page without a number.

## Testing

`npm run test:carriers:live -- carriers/zgtux` tracks the public sample, or the number in `ZGTUX_TRACKING_NUMBER`,
and checks an invented waybill, or the one in `ZGTUX_UNKNOWN_NUMBER`, reads as not found, a few seconds later so
the server does not refuse it.
