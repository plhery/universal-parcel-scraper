# TTK Europe

TTK Europe (天天欧洲物流) is a parcel line from the United Kingdom to China, where China Post
delivers. The adapter reads the open lookup behind the tracker on ttkeu.com.

## How it works

1. `direct`: one `GET https://ttkeu.com/api/open/tracking/?mail_num=<number>` with
   `Accept: application/json`, as the tracking page asks it. It needs no cookie, session or
   CAPTCHA.
2. `retry`: the request once more when it fails to reach the service or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- The reply's `data` holds a record whose `mail_no` must be the number asked; a record for
  another number is indeterminate. Its `tracking` rows are the history, newest first.
- `单号不存在` with empty `data` is the only not-found answer. `请提交要查询的单号` means the
  service read no number, so the request changed: a schema failure. Any other empty answer is
  indeterminate, and a record without a row is no history (`listed`).
- Each row is worded in Chinese, then in English. The adapter keeps the English half, which the
  status map reads, and the place written in `【】` as the location.
- The record names China Post (`classify` `youzheng`) and the domestic number it delivers under
  (`related_mail`). That pair becomes the delivery carrier and its number only when China Post's
  own rules take the whole number. The sample's domestic number is thirteen digits that no rule
  names, so it is left out.

## Notes

- The rows state no zone and mix the clocks of both countries. A row placed in China (the airport,
  customs, China Post) is dated on Beijing's clock, and a row placed in the United Kingdom (its
  depots, the processing centre, Heathrow) on London's, with `time_zone_basis` `place`. A notice
  without a place keeps its wall clock alone.
- Customs' release and the hand-over to China Post are written at the same minute, in either
  order. Rows at one clock follow the order of the journey in `statuses.json`, so the hand-over
  leads.
- The repeat consignee notice holds the parcel for the next batch. The map reads it as pending, so
  the stage stays the one before.
- A depot's receipt names the staff member who took the parcel in. The name is taken out of the
  wording.
- The record's `status` and `idcard_check` are not shown on the tracking page and are not read.

## Limitations

- TTK Europe writes nothing after the hand-over; the delivery is on China Post's tracker, under
  the domestic number.
- No delivery estimate, weight, service, recipient or proof of delivery.

## Numbers

`TE`, nine digits whose last is the S10 check digit, and `GB`. That is Royal Mail's layout, and its
rule takes these numbers at high confidence, so no rule offers TTK Europe: select the carrier
explicitly or open its link. The numbers run in dense sequences, so a number invented beside a
real one can be someone else's parcel. The not-found control is invented far from any range seen.

## Links

The tracking detail page opens a number from its `id` parameter.

## Testing

`npm run test:carriers:live -- carriers/ttk-europe` reads the public sample in `numbers.json` and
an invented unknown number; `TTK_EUROPE_TRACKING_NUMBER` and `TTK_EUROPE_UNKNOWN_NUMBER` replace
them.
