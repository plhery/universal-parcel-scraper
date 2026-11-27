# Yijiang Express

Yijiang Express (驿将快运, 福建驿将快运有限公司) is a Fuzhou express firm that carries parcels between Chinese
cities through its own depots and hubs. Its site is yijiangky.com. Tracked through the lookup behind the
tracking page on that site.

## How it works

1. `direct`: one `POST http://www.yijiangky.com/query.aspx?pID=3&v={random}` with the form the page's script
   sends: `_action=query&txtIsNumber=1&txtData[txtnumbers]={number}&txtData[txtphone]=&key=yijiangky&secret=yijiangkycom`.
   `key` and `secret` are constants written in the page, the same for every visitor; no cookie, session or
   browser is needed. The site answers plain HTTP only: nothing listens on HTTPS. The reply is JSON served as
   HTML.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of the
   budget, so the retry fits in the rest.

- The reply lists an entry for each number found, its `num` and its `details`, newest first. Only the entry
  whose `num` is the whole number asked is read; a reply for another number is not an answer.
- `{"result":"true","message":"查无结果","data":"[]"}` is the lookup's answer for a number the firm holds
  nothing under, which is not found. Any other reply, such as a refusal of the key, is a changed lookup; HTML
  in its place is a browser check or a changed page; a redirect is a moved page.
- The form takes up to ten numbers split by `,`, so the adapter refuses anything but letters and digits.

## Notes

- Clocks are wall clocks to the second with no zone. The firm is in Fuzhou and its rows are its depots' in
  China, so each row is dated on China's clock with `carrier` as the basis and keeps its wall clock. A clock
  that would date a row after the lookup leaves it its wall clock alone.
- Each row gives its city in `location`, which becomes the event's location.
- The reply's `state` reads "0" for a delivered parcel too, so the stage comes from the rows. Rows have no
  code; `statuses.json` records each wording seen, the parcel count some rows end with made an ellipsis, and
  the status map reads the rows that name a depot or a town by their pattern.
- The rows seen name no courier. A name the wording gives after a role (派送员, 签收人 and the like), with a
  label, in brackets or before a pause or the verb, comes out, and so does any phone number with its label. The
  firm's own 400 service line stays. A row left with nothing is dropped.

## Limitations

- No delivery estimate, weight, service name, sender or recipient.
- The page also finds parcels by the recipient's phone number; the adapter asks one waybill.

## Numbers

The waybill with history is YJ and twelve digits; the test number kuaidi100 lists for the firm has another
layout, and the lookup holds nothing under it. Too few to claim a shape, so detection does not name the firm
(see `core/detection/gaps.json`). The adapter answers explicit selection of any number of 6 to 30 letters and
digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

No tracking link: the lookup answers a form post only, over plain HTTP, so the catalog links neither it nor a
search page.

## Testing

`npm run test:carriers:live -- carriers/yijiangky` tracks the public sample, or the number in
`YIJIANG_TRACKING_NUMBER`, and checks an invented number, or the one in `YIJIANG_UNKNOWN_NUMBER`, reads as not
found.
