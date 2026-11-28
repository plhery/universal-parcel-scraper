# Thai Bear Logistics

Thai Bear Logistics (泰熊物流) runs a China–Thailand line in both directions: goods sent to its Guangzhou
warehouse go by road, sea or air to its Bangkok warehouse and on with a Thai courier, and the reverse.
Its site is tobkk.cn.

## How it works

1. `direct`: one GET of `https://www.tobkk.cn/track.php?order_num=<number>`, the Chinese tracking form.
   No session, cookie, account or browser.
2. `retry`: the same request once more when the first fails to reach the site or hangs.

The form takes up to ten numbers separated by semicolons; the adapter sends one. The page lists each order
with its number, its overall label, the Thai courier's number (配送单号) and its scans grouped under labels,
each scan a Chinese wording and a time. An unknown number gets `暂无此单号，请核实单号信息！`, read as not
found only when the form on the page keeps the number asked.

## Notes

- The scans keep their wall clock; the page gives no zone.
- The wordings carry the stage (`statuses.json`, `{station}` standing for the bracketed warehouse or
  courier). The group labels give one only where all their scans share it: 已完成 (done) covers both the
  hand-over to the Thai courier and the delivery.
- The Thai courier's number is `delivery_tracking_number`. The courier named in the hand-over scan is
  `delivery_carrier` when it is Flash Express, Thailand Post or J&T.
- The English page, `track-int.php`, reads the same records.

## Limitations

No delivery estimate, weight, sender or recipient. The public sample is a demonstration order whose
scans all fall within one minute.

## Numbers

The public example mixes letters and digits, from one sample only, so there is no detection rule and no
recognition: a lookup asks Thai Bear only when the user picks it.

## Testing

`npm run test:carriers:live -- carriers/tobkk` reads the public sample, or `TOBKK_TRACKING_NUMBER`.
