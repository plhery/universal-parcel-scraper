# GZYL

Tracks shipments of GZYL (广州云链货运代理有限公司), a Guangzhou forwarder, on its own tenant of
the Hualei (华磊) forwarder platform. [Tianhui Hengyuan](../thhy/README.md),
[JRT](../jrt/README.md), [Meiteshun Logistics](../mtscn/README.md),
[Mayi Yinfu](../mayiyinfu/README.md), [BYHD](../byhd/README.md), [BYT](../byt/README.md),
[MeiHoo Pegasus](../meihoo-pegasus/README.md), [Pengyou](../pengyou/README.md),
[Kun Express](../kun-express/README.md), [JHGJ](../jhgj/README.md),
[SPT Express](../sptexp/README.md), [Huaya Express](../huaya-express/README.md),
[Lingdong International](../lingdong/README.md), [Meso-global](../meso-global/README.md),
[SHENGAO](../shengao/README.md), [Wiio](../wiio/README.md),
[Yilong Logistics](../yilong-logistics/README.md) and [YouBang Express](../youbang-express/README.md) run
tenants of the same platform; they share the client in [hualei.ts](hualei.ts) and keep their own hosts and
status maps.
[Xinghe Freight](../xinghe-freight/README.md) tracks on GZYL's own tenant.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `134.175.243.207:8082`, the platform's documented track interface. It answers JSON encoded in
   GBK, with one record per order and its rows. When it says it holds no row (`未查询到轨迹`),
   or, as some tenants do for an unknown number, answers one record that only echoes the number
   as its reference, without an order id, another number or a row, the adapter posts the same number as the `documentCode` field to `trackIndex.htm`, the
   tracking page the tenant's site opens. The page answers an unknown number with an empty
   waybill that only echoes the number, which is the only not-found; on
   [LJS's](../ljs/README.md) older tenant, with its bare search form, no waybill and the number not
   echoed, which is not-found there alone (`bareUnknownPage`). An order without pieces,
   destination or scans yet shows the number as its tracking or transfer number too, and has no
   history yet. It also shows the
   platform's own row for an order without scans, which some tenants' interfaces leave out.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs. The
   first attempt gets half of the budget.

No account, key, cookie, CAPTCHA or browser is needed. The trackers answer plain HTTP only, on a
bare address; the shared transport allows it. No portal link is published, since a plain-HTTP
link would leave the number in the clear, and the canary, which takes HTTPS only, checks 17TRACK
instead.

## Notes

- The service matches a number exactly as written: the order's tracking number, the shipper's
  reference, the waybill code or the channel's transfer number, dashes included. A record counts
  only when one of those is the whole number asked; otherwise the error names the record's
  fields that hold the number, a child parcel's list included, without their values, or failing
  that the shapes of the record's own numbers, letters and digits counted. Two orders under one reference stay
  inconclusive. [BYHD's](../byhd/README.md) page hides the number it found an order by, so there
  a lone record counts for the one number the page's form echoes back. [JRT's](../jrt/README.md)
  interface stops returning JRT's own number once the delivering carrier's takes the tracking
  number, so there a lone record holding none of a JRT number counts for it, and so does a lone
  page waybill whose form echoes that number alone; [Lingdong's](../lingdong/README.md) tracker
  does the same with its SZLD numbers.
- GZYL writes a shipment's timeline ahead: every row carries the same creation time, days before
  most of the scan times. A row the track interface says was written more than twelve hours
  before its own clock is a forecast, not a scan, and is held back on every tenant; the margin
  leaves room for a destination's clock, up to six hours ahead of Beijing's, on the tenants that
  keep their rows' wall clocks (below). A row written in the same second as such a row, more than
  six hours before its own clock, is the same script's and is held back too. GZYL writes its own,
  Xinghe Freight's and Yusuda's whole feed as one such script, from one template to a delivery no later
  scan followed: there a second in which a row was written more than half an hour before its own
  clock is the script's, and every row of it but the order's registration is held back, however
  soon its clock. A universal provider's copies of these three carry no creation times, so every
  one but the registration is set aside when the provider's answer is read. The page shows no
  creation times, so a row dated after the lookup on Beijing time is held back too. An order
  whose rows are all held back has no history yet. Either way the clocks of the rows written
  ahead are named, in `written_ahead` or the error, and the rows are kept as planned steps, so
  that a universal provider's copies of them are set aside too: GZYL's order row alone is kept while the script fills a provider's
  history. The record's own summary status is not read; the stage comes from the rows kept. A
  row a tenant names as a notice, such as a flight booked before it flies, is a forecast: it
  keeps the stage of the scan before it, with no source of its own, and decides no status.
  After a row a tenant's map reads as returned, a move or a delivery is the parcel going, or
  delivered, back to the sender, and is returned too, until a row says the shipper received
  it: the rows after that are the parcel sent again, and the shipper's receipt is then an
  exception, a problem on the way, since an app holds a return over the moves after it.
- GZYL's script ends in a delivery row the platform writes in an evening batch, at a clock the day
  after the script's last row and in Beijing's office hours whatever the destination, Mexico's and
  Canada's included. Readers who got no parcel marked it wrong. On a record with rows written
  ahead, a delivery row is held back and named with them; on one written as it happened, it is a
  scan. The page shows no creation times, so a delivery row it shows is held back and named too.
  Xinghe Freight's records, on the same tenant, are read the same way.
- Rows coded `CO_C_CR` come from the platform's custom track product (轨迹定制), which writes
  them to a script: on Tianhui Hengyuan they read like China Post's scans, all on one second of
  the minute, and on Mayi Yinfu they have the parcel abroad before it reaches the airport. Each is
  written at its own clock to the second, at a fixed lead after the departure from the operations
  centre: on ED POST a day and a second after it, while the flight rows people add come after their
  clocks. They are held back on every tenant and named like rows written ahead.
- A record's product (`productKindName`) is the service name, in English where every Chinese
  term of it is known ("欧洲DHL快线-A" is "Europe DHL Express Line-A"), else as written.
- Rows carry wall clocks without an offset, abroad too, on the trackers' Beijing clock: rows
  at the destination were shown up to seven hours before their clock read as UTC, earlier than
  the destination's own clock allows, and on the destination's clock some delivery rows would be
  written before they happened. Every row is read on Beijing time, as on the other tenants
  except Mayi Yinfu, where a row copied from the delivering carrier without a place can come on
  that carrier's clock, and [Kun Express](../kun-express/README.md), whose rows copied from USPS
  are on the facility's clock. Each scan keeps the platform's clock when its row was written as
  `written_at`, from the track interface: a row written as it happens is written minutes after
  its clock, so stored rows show which clock a destination's rows are on.
- The platform can write a partner's row again. A copy written after a European clock change
  reads the partner's clock an hour off: Meso Global's DHL rows written in summer time came again,
  written after the change, an hour later. Of two rows alike but for clocks an hour apart, the one
  written later is dropped only when the writes are at least a day apart.
- GZYL leaves a row's place empty and writes the town after some wordings, as in "Leaving the
  sorting center" followed by the town, a postcode sometimes before it. The adapter cuts the
  postcode and reads that town as the place, so a wording reads the same for every town. A row can also name its city after the wording, in brackets,
  China Post's full-width ones included; the status map reads the wording without it, and the row keeps it as written.
- A record that names its channel and the channel's transfer number hands the parcel over when
  the channel label is in the platform's table, the delivery carrier's own detection offers the
  number and it serves the destination. The table holds Swiss Post's labels, the destination of
  every record seen; no live record has named a channel yet. On a tenant that names the carriers
  it hands records to unnamed, such as JRT's DHL, a number such a carrier's own high-confidence rule
  claims whole is that carrier's under a channel too, unless the label names another carrier: in the
  table, or by a catalog name or brand among its Latin words. The page names no channel or service,
  so a channel's partner is read from the interface alone; the page applies a tenant's own-number
  rule and the partners it hands to unnamed as the interface does. A tenant whose rows name the
  number the parcel goes on under, as BYT's "the new tracking number is …", gives the newest one
  as the delivery carrier's when the record has no transfer number, under the same rule, and so
  does the invoice number, which [Wokexp's](../wokexp/README.md) line fills with Poste Italiane's.
- A tenant can name the carrier whose scans its line copies under that carrier's waybill, as
  [HJYT's](../hjyt/README.md) and [Qyun's](../qyun/README.md) copy iMile's, a shape that carrier
  shares with others and no rule ties to it with high confidence. The record is that carrier's
  when its own detection offers the tracking number, it serves the destination, a row is one of
  its copies, as the tenant tells them, and no channel names another carrier.
- Recipient, sender, address, postcode, weight, fee, signature, signatory and delivery photo
  fields are never read; postcodes, with a country's letters before them (`CH-`), and signatories
  are cut from scan text, including a delivery row's place, which can carry the recipient's
  postcode. Wording can name it too, so the cut covers the whole row; a date's year stays. A row stored with one takes the place without it
  ([identity.ts](identity.ts)).
- Some tenants print "SYSTEM" or "Delivery Location" in a row's place when it has none, and a
  relayed label row can read "US, SYSTEM, SYSTEM"; those are not read as a place, and a row stored
  with one is taken over by the same row without it.
- A row can write its place again at the head of its wording ("US, SYSTEM, SYSTEM, Shipping Label
  Created"); the wording is read without it, and a tenant whose rows were stored that way takes
  them over ([identity.ts](identity.ts)).
- GBK has no room for some spaces, so a space between two words, or between a month and its day,
  can arrive as `?`; scan text reads it as the space it was, and a row stored with the `?` is taken
  over by the same row with the space. GBK has no ô, ç or î either: in the French words a
  destination post's rows use ("bient?t", "re?u", "dép?t", "bo?te") scan text puts the letter back.
- GBK has no room for some scripts either: a partner's row in Hebrew arrives with each letter a
  `?`. When a row's wording or place is only question marks, spaces and punctuation, the adapter
  posts the number to the tracking page, which is UTF-8, and takes that wording and place from the
  page's row on the same clock that reads the same where the interface has no `?`. The row keeps
  the interface's kind code and creation time. Without a page that shows the number as one
  shipment, the row stays as it came.
- A partner's row can come with its markup, escaped or not, such as DHL's help link; scan text
  keeps the words without it.

## Limitations

GZYL's records on a scripted line show no scan after the order, and name no delivering carrier or
number.

A reference stored without its dashes, as `normalizeTrackingNumber` stores every number, is not
found: the tracker matches it only as written. A record with the delivery carrier's number
but no channel label hands nothing over, except on a tenant that names the carriers it hands
records to, as [Mayi Yinfu](../mayiyinfu/README.md) does, or whose scans it copies, the carrier a
product names, as [JRT's](../jrt/README.md) line to Ireland names FedEx.

## Numbers

GZYL's waybills are YL, ten digits and YQ, made by a Hualei number rule. Many forwarders end
their numbers with YQ and Yili International's are YL, nine digits and YQ, so the rule has low
confidence and recognition asks the tracker. GZYL's own tracker answered every parcel the app
tracked in the `YL738` series, and no other carrier's rule takes the layout, so `gzyl-2` names
GZYL for that series at high confidence. Since the page tells an unknown number from an
order, recognition knows an order before any of its rows is due, on every tenant of the platform
that recognition asks. No public GZYL number has been found, so the corpus holds a synthetic
one. The tracker accepts both the waybill's tracking number and its reference number.

## Testing

`npm run test:carriers:live -- carriers/gzyl`, with `GZYL_TRACKING_NUMBER` and optionally
`GZYL_UNKNOWN_NUMBER` set outside the repository.
