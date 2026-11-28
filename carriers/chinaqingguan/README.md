# Rongtong International

Rongtong International (荣通国际货运, 荣通清关), based in Guangzhou, clears parcels of personal goods sent to China
at Guangzhou Baiyun airport, then hands them to a courier for delivery in China. Its site is chinaqingguan.com.
Tracked through the site's waybill search, behind a four-digit verify code.

## How it works

1. `direct`: one `GET http://www.chinaqingguan.com/cha/index.php?m=Index&a=code`, the verify code picture, which
   opens the PHP session the code is kept in. The shared text model reads it, and one `POST` of `inputNumber` and
   `checkcode` to `/cha/index.php?m=Index&a=soso` returns the result page, UTF-8. The site answers over plain HTTP
   only.

- A refused code gives ThinkPHP's jump page 您输入的认证码有误!. The adapter then takes a new picture in a new
  session, four pictures in all within the lookup's budget, and skips a reading that is not four digits without
  sending it. When none is accepted the lookup fails as a challenge whose message counts the refused and unread
  pictures.
- The result page names the number in its header, 您的快递运单号…的查询结果如下; a page for another number is
  refused. `<number>单号信息不存在` for the number asked is the tracker's answer for a waybill it does not know,
  which is not found. A page with neither, or a jump page with another message, is a changed page.

## Notes

- The model reads about three of every four pictures. The pictures are 50 by 24 GIFs of four digits, framed in
  grey; the worker's `chinaqingguan` profile cuts the frame off and keeps the picture's proportions, which read
  best of the settings tried. No picture showed a letter, so the case of letters does not arise.
- The firm's own rows, oldest first below a dashed line, are each a minute on the clock in Guangzhou, with no
  zone, and are dated on China's clock with `carrier` as the basis. A row dated after the lookup keeps its wall
  clock alone. The airport a row starts with, after the kind of goods, is its location.
- Above the dashed line, once the parcel is cleared, a line names who delivers it in China and the number, as
  转交…进行国内派送，运单号是：…, followed by the domestic leg's rows or NULL 查询无结果 while it has none. That courier
  is the delivery carrier, with that number, when it is a courier in the catalog whose rules take the number.
  The firm names itself or an unnamed partner there and keeps the same number, which is no hand-off. The domestic
  rows are read as the firm's are, without couriers' names and phones.
- Every parcel the firm clears is bound for China, which is the destination.

## Limitations

- No delivery estimate, weight, service name, sender or recipient.
- The domestic leg's rows have only been seen as NULL 查询无结果.
- The search only answers a form post with a session's code, so the catalog gives no tracking link.

## Numbers

The public sample is thirteen bare digits, a shape many carriers' rules take, so detection does not offer
Rongtong International, and the adapter answers explicit selection of any number of 12 to 30 letters and digits.
The sample and its source are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/chinaqingguan` tracks the public sample, or the number in
`CHINAQINGGUAN_TRACKING_NUMBER`, and checks an invented number, or the one in `CHINAQINGGUAN_UNKNOWN_NUMBER`,
reads as not found.
