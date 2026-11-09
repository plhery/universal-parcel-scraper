# JS Express

JS Express (急速国际), run by 急创速供应链管理（苏州）有限公司, ships parcels abroad from China
for online shops, through dedicated lines, express and postal services, and a local carrier
delivers them. Tracked through the lookup its English tracking page makes. 17TRACK's carrier
list names it "JS" (the js-exp.com entry), so that name is an alias.

## How it works

1. `direct`: one `POST https://www.js-exp.com/EN/index.php?c=trace` with the form body
   `card_num={number}`, as the script of the English tracking page `EN/index.php?page=19` sends
   it, with that page as the referrer. It needs no cookie, token, captcha or browser. The reply
   is JSON, served as HTML: the waybill, the country it goes to, the destination courier's
   number once it has one, and the scans newest first.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. With TRAWL configured, the HTTP attempts leave time for browser recovery.
3. `trawl`: after a browser check, the optional TRAWL service opens the same guest lookup
   with `card_num` in its GET query. It reads the JSON text the browser renders and applies
   the same whole-waybill, history and clock checks. No custom browser helper is needed.

- An unknown number gets `code` 1 and "未获取到任何数据,请提供有效单号!", which is not found. A
  waybill without scans, which the page's script shows as "暂无轨迹数据", has no history. An
  empty reply is inconclusive. A 403, a Cloudflare check, a captcha prompt or the lookup's
  refusal alone in place of the answer is a challenge. A 404 or a redirect is a moved route.
- The reply must name the whole requested number as `jsWaybillNo`. The tracker matches whole
  numbers only.
- Recognition stays on HTTP and opens no browser session. A rate limit, explicit missing
  parcel or changed schema does not start browser recovery.

## Notes

- The Chinese tracking page's query button posts to `index.php?c=test` and asks for an image
  captcha first. The home page's form renders the same scans without it, but not the courier's
  number or the country. The English page's lookup gives both without a captcha, so the adapter
  uses it.
- Without the tracking page as its referrer, the lookup prints the refusal "非法请求" and then
  answers anyway. The adapter sends the referrer and drops a refusal printed before an answer.
- `trackNo` is the destination courier's number and becomes the delivery tracking number; a USPS
  routing barcode gives its package identifier. The reply does not name the courier. It is the
  carrier the catalog settles the number for at high confidence, when that carrier works in the
  country the parcel goes to, and the tracker then asks that carrier's adapter. DHL Paket's
  twelve digits and JJD with sixteen are shapes other couriers use too, GLS Germany's and
  InPost's among them, so such a number names DHL only on a German parcel whose history holds
  DHL Paket's own rows.
- A row is a clock, a place and a wording. Clocks are wall clocks to the second, with
  no zone, and one history mixes China's with the airports' and the destination courier's, so
  the reply's order stands.
- A row at a place in mainland China, named for the country, a region such as South China, a
  province or a city, or written in Chinese other than Hong Kong's, Macau's or Taiwan's, is on
  Beijing time. A flight's departure filed there keeps its wall clock:
  one has come hours after its flight could have left, given the landing that followed.
- In a history that names Straightship, its rows are on UTC, the clock of Straightship's own
  page: those that name it, those whose wording ends with a town and a Canadian province, and its
  placeless "Package information is created in the system", which its page shows on the same wall
  clock.
  Straightship's record of the parcel's data comes within a minute of the Chinese warehouse's
  inbound scan only when the one is read on UTC and the other on Beijing time, and its
  deliveries then come before the 9 pm its round promises.
- USPS's scans come from two feeds. Those to the minute, with the town, state and postal code,
  are on the town's clock, as USPS's own delivery at the same minute shows. Those to the second,
  such as "Arrived at USPS Facility" at a distribution centre, are on UTC: a copy of USPS's label
  came at the instant USPS gave it read on UTC, and an arrival read on Chicago's clock would have
  come hours before it happened.
- Each row also carries an offset, often another place's: Straightship's rows carry China's,
  Amsterdam's carry its winter offset in summer, and Gatwick's and Singapore's others. A row
  without a place is read on the destination's clock when the destination keeps one clock and the
  row's offset is that clock's at its wall clock, as the destination post's and courier's rows
  are. Other rows at an airport's code or without a place keep `local_time`, as do other
  couriers' rows: iMile's name no country. The newest row's instant, when it has one, is the
  last update, and a dated delivery's is the delivery time.
- JS Express's own rows and its partners' share the history in their partners' words. A
  destination courier's wording repeats the place with its province, as "Delivered (Sample Town,
  ON)": the adapter moves it into the location, so the wording stays the same from town to town.
  A place without a letter, such as "1", names no place and is left out, as is the tracker's
  "Array" for a partner's place it holds as a list.
  JS Express's own status in Chinese shows the English its entry in
  [statuses.json](statuses.json) gives, and takes over the row stored in Chinese.
- The tracker relays China Post's domestic scans from two feeds: one dates them to the minute
  and places them in the town, the other to the second with the office's code after the town,
  and can word an arrival differently. A scan from one takes over the row stored from the other
  less than a minute away, so the parcel does not show each scan twice when the tracker switches.
- iMile's scans as the destination courier open with the centre's name in 【】, so each pair of
  centres makes a new wording. They take the stage iMile's own sentences give, as its adapter
  reads them.
- J&T Express Germany's scans as the destination courier, in German, open with the district in
  【】 and name its sites in 【】. Emptied of those names, they take their entry in
  [statuses.json](statuses.json). Its first scan, when it takes the parcel from the line's hand-over,
  is in transit. Its German rows, its round, delivery and record of the order's data among them, are
  dated at the offset they state. Neither the wall clock nor that offset is Germany's, but together
  they give the instant J&T Express Germany's own tracker gives each scan, to the second, and the
  order's data then comes as JS Express's sorting centre takes the parcel in. Read on Berlin's clock,
  they would come two hours early.
- Each row carries a code, kept as its `provider_code`. Most rows are `OIT` whatever happened, so a
  code gives a stage only to a wording the map lacks, and only where it settles one alone: the
  order's data, the collection, the round, the pickup point, a failed attempt and the delivery.
- The delivering depot's receipt comes before each round and again after a missed delivery. It is a
  notice that keeps the stage of the scan before it with no source of its own: in transit before a
  round, and after a missed delivery the miss, as the parcel waits for the next round or the
  recipient's request, so it does not step back to in transit. The recipient's redirect after the
  third miss moves the parcel on.
- The waybill's `estimateArriveTime` is the expected delivery, its day alone since a clock after
  it names no zone. Straightship's round gives its own day in the town's province instead, while
  the parcel is on it.
- Partners' records of the parcel's data move nothing and have no stage. Straightship's "Package
  will be delivered before 9:00pm" is its driver's round, out for delivery, as Straightship's own
  map reads it.
- A courier's announced return, such as Colissimo's "Il va être retourné à l'expéditeur", is an
  exception: the parcel is returned only once a scan has it back with its sender.
- A delivery loses a clause naming who took the parcel, as iMile's receiver type, and every row
  loses phone numbers and the label left before them, as JS Express's "当地电话：" (local phone)
  or "Local phone number:/".

## Limitations

- The reply has no summary, weight or service, and does not name the destination courier.
- The delivery photos and the shop's order number are not read.

## Numbers

JS Express waybills are `JSE`, two capital letters, ten digits and `YQ`, the layout 17FEIA,
WanbExpress, SFC and CJ Packet use with prefixes of their own. The `JSE` prefix is JS
Express's own, so `js-express-1` claims the layout and the adapter takes nothing else. A
letter O typed among the ten digits is a zero: the tracker knows such a waybill only with the
zero, and `normalizeTrackingNumber` reads it so. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/js-express`, with `JS_EXPRESS_TRACKING_NUMBER` set
outside the repository. Optionally set `JS_EXPRESS_DELIVERED_NUMBER` to check a delivered
waybill and `JS_EXPRESS_UNKNOWN_NUMBER` to check a number the tracker does not know.
