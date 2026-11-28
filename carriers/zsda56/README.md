# Zhuanshunda

Zhuanshunda (转瞬达集运, ZSD) is a consolidation forwarder in Shenzhen: it collects a customer's online orders at
its warehouse, packs them into one parcel and sends it abroad, to Canada, Europe, the United States, Australia and
Taiwan. Tracked through the tracking page on zsda56.com.

## How it works

1. `direct`: one `POST https://www.zsda56.com/postdh.php` with the home page's form: `keyword`, `prid=2`, the tab
   for parcels sent abroad, and `act=searchs`. It needs no cookie or account. The reply is HTML: the parcel in a
   list item that names its number and destination, and a table of rows, newest first, each a clock and a text.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of the budget,
   so the retry fits in the rest.

- The list item, `for_<number>`, must name the number; a parcel of another number is refused.
- The row 查无此单号 under a title naming the number, as `快件跟踪查询_<number>_…`, is the answer for a number the
  firm holds nothing under, which is not found. A page with neither, or without the form, is a browser check or a
  changed page, and a non-200 reply is a moved page.
- The form takes the number only in its body, so the catalog gives no tracking link.

## Notes

- Clocks have no zone and come to the second or to the minute. The firm works from Shenzhen and its rows name no
  place, so every row is dated on China's clock, with `carrier` as the basis.
- 包裹付款, the customer's payment, can come months after the parcel moved. It is `pending`, so the row before it
  sets the stage.
- The destination is the list item's country after 发往, as `TaiWan 台灣`, when that names one country.

## Limitations

- No location, delivery estimate, weight, sender or recipient, and no delivery carrier at the destination.
- The form's tab for domestic numbers, `prid=1`, is not asked.

## Numbers

Parcels are ZSD and six digits on the sample. No other carrier's rule or sample takes that shape, so detection
offers Zhuanshunda for it and recognition asks the tracker; the adapter answers explicit selection of any number
of 6 to 30 letters and digits. The sample and its source are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/zsda56` tracks the public sample, or the number in
`ZSDA56_TRACKING_NUMBER`, and checks an invented number, or the one in `ZSDA56_UNKNOWN_NUMBER`, reads as not found.
