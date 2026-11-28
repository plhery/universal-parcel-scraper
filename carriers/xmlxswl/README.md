# Longxinshun Logistics

Longxinshun Logistics (隆新顺物流, 厦门隆新顺供应链有限公司) is a road freight firm in Xiamen. Its site, xmlxswl.com,
has no tracker of its own: its 物流查询 link opens the firm's page on 1008656.com, Lanqiao's (蓝桥) tracking
platform, under company id 73320.

## How it works

1. `direct`: one empty `POST https://www.1008656.com/index.aspx?do=waybill&id=73320&keyword=…`, the lookup the
   firm's page sends for a number. No session, cookie, account or browser.
2. `retry`: the same request once more when the first fails to reach the platform or hangs.

A waybill's reply is JSON, `{"track":[{billdate, content}, …]}`, oldest first. A number the firm holds no waybill
under gets a script literal, `{status:1,msg:'当前查询的单号：…不存在!'}`, read as not found when it names the number
asked. Any other refusal, or a notice about another number, is indeterminate.

## Notes

- The platform serves every firm on it; the company id in the request is what binds the reply to Longxinshun. A
  waybill's reply names neither the firm nor the number, so the adapter cannot check either.
- Rows are dated by their day alone (`2023/11/4`), kept as `local_time`. A row that gives a clock is
  dated on China's clock with `carrier` as the basis.
- A row starts with its place in brackets (`【厦门】开单入库`); contacts and plates inside a row are dropped by the
  shared Lanqiao reader in [`../anjiexin56/lqfast.ts`](../anjiexin56/lqfast.ts).
- The platform matches the number against a whole-number column and answers letters with a database error, so
  the adapter takes digits only.
- The wordings are staged by `statuses.json` through the Lanqiao status helper; others fall to the shared
  wording rules.

## Limitations

No delivery estimate, weight, piece count or proof of delivery: the reply holds the rows alone. A pasted
platform link is not recognized, since the domain serves many firms.

## Numbers

The public example is seven digits, a shape many carriers share, so there is no detection rule and no
recognition: a lookup asks Longxinshun only when the user picks it.

## Testing

`npm run test:carriers:live -- carriers/xmlxswl` reads the public sample, or `XMLXSWL_TRACKING_NUMBER`.
