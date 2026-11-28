# MoreLink

MoreLink (无限链接, 广东无限链接信息科技有限公司), based in Dongguan, Guangdong, forwards goods by sea and air
from its warehouses in China, much of it to Amazon warehouses abroad. Tracked through the order search on
client.morelink56.com, behind a four-character verify code.

## How it works

1. `direct`: one `GET https://client.morelink56.com/homepage/GetValidateCode?time=<ms>`, the verify code picture,
   which opens the ASP.NET session the code is kept in. The shared text model reads it, and one `POST` of
   `ordercode` and `strorderno` to `/homepage/seeorderdata` returns JSON whose `data` is itself a JSON string.

- A refused code gives 验证码不正确, and a session holding no code 验证码过期. The adapter then takes a new picture
  in a new session, four pictures in all within the lookup's budget, and skips a reading that is not four letters
  and digits without sending it. When none is accepted the lookup fails as a challenge whose message counts the
  refused and unread pictures.
- Every row names the order in `sono`, which must be the number asked. 抱歉！未查到此运单<number>信息 for the number
  asked is the tracker's answer for an order it does not know, which is not found. Any other message, or a reply
  that is not this JSON, is a changed reply.

## Notes

- The tracker takes the code's letters in either case: codes sent with every letter's case swapped were accepted.
  The model read 18 of 21 pictures labelled by eye, letters' case aside, and each of the twelve codes it read during
  live lookups was accepted. The pictures are 131 by 41 JPEGs of four letters and digits on speckled ground; the
  worker's `morelink56` profile keeps their proportions, which read best of the settings tried.
- Rows are a status word, then a remark after a space, such as the vessel and voyage; the status word gives the
  stage. 订单预受理, a notice naming the order, may be dated after delivery and moves nothing.
- Rows carry a wall clock with no zone. Rows up to the vessel's or flight's departure are in China and dated on
  China's clock with `carrier` as the basis. From the arrival on, a row keeps its wall clock alone, unless its
  remark names a place in brackets in the destination country and that country keeps one clock: the destination
  rows give no place, and their clocks, with seconds counting up from one day to the next, are not the port's.
- `addr` starts with the destination country in Chinese, then the Amazon warehouse's code (日本FSZ1): the country is
  the destination, and the warehouse code is left out.
- Each row links a proof of delivery picture (`podfile`, `picture`), which may show signatures; it is never read.

## Limitations

- No delivery estimate, weight, service name, sender or recipient.
- Destinations are named for the countries Chinese forwarders commonly serve; another country gives no destination.
- The search only answers a post with a session's code, so the catalog gives no tracking link.

## Numbers

The public sample is fifteen bare digits, a shape other carriers' numbers share, so detection does not offer
MoreLink, and the adapter answers explicit selection of any number of 6 to 30 letters and digits. The sample and its
source are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/morelink56` tracks the public sample, or the number in
`MORELINK56_TRACKING_NUMBER`, and checks an invented number, or the one in `MORELINK56_UNKNOWN_NUMBER`, reads as not
found.
