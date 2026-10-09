# China Post

Tracks China Post's international postal items (S10 numbers ending in `CN`)
through the guest trace API of China Post's EMS app. EMS items issued in China
(`E…CN`) are detected as China Post and read here too; the
[EMS adapter](../ems/README.md) reads the EMS Cooperative's tracker when EMS is
chosen. Domestic 13-digit waybills are out of scope and rejected before any
request. Source selection is covered in
[ROUTING.md](https://github.com/plhery/delivery-tracker/blob/main/docs/ROUTING.md);
provider results are in [COVERAGE.md](../../providers/COVERAGE.md).

## How it works

The web tracker on www.ems.com.cn sits behind a web application firewall and a
click CAPTCHA. A normal browser can reach the form, while plain HTTP can receive
a block page. Completing the character challenge permits an anonymous preview of
two scans from `/ems-web/mailTrack/queryTrack`; full history requires login. The
preview can show a later processing scan above a delivered scan, so its first
row alone does not establish the parcel's stage.

China Post's EMS app (Android package `com.kun.ems`) looks up guests through
`https://ec.ems.com.cn/ect-web` without an account, cookie, CAPTCHA or browser,
and the China Post app hands tracking to the same backend. A lookup makes two
POST requests with the body `{"mailNo":"<number>"}`:

1. `/mail/getGisTraces/checkMail` opens the trace for the number. The app reads
   its `info`: 2 asks for the last four digits of a contact phone, 3 shows "no
   logistics information", and any other value opens the map. The adapter does
   the same.
2. `/mail/getGisTraces/subjection/v3` returns the mail record. Without a fresh
   check step it answers `600001`, so both calls belong to every lookup.

Each request carries `USER-CHANNEL: APP` and a `USER-SIGN` header: the Base64
HMAC-SHA256 of the path after `/ect-web`, followed by `?json=` and the exact
body. The key is compiled into the app's bundled web code and is the same for
every install; it is included with the maintainer's approval.
`CHINA_POST_TRACKING_KEY` replaces it, and an empty value disables the adapter.
A refused signature (`签名验证失败`), a request to sign in (including the codes
`200001` and `200002`, which the app reads as an expired login), the
firewall's block page and a web page returned instead of JSON are reported as
challenges.

## Results

The record must name the requested number in `info.mail.mailNo`; any other
record is a schema error. A null `info` or a null, blank or empty mail record
is what the app shows as "no logistics information", so it is inconclusive.
Scans arrive oldest first and are returned newest first in the service's order,
not re-sorted. Each scan keeps its office, airport or country (`orgName`), its
scan code (`operationCode`) and a short text. An airline handover can name the
airline as its office (邮政航空); an airline is no place, so that scan has no
location. A destination office that names itself only by code (`orgCode`) is
placed in the destination country when the code is the country's own or a UPU
office of exchange code starting with it; airline handovers also use codes, so
no other code becomes a place.

Guests receive only the three newest scans. When `mailInfoCount` is larger than
the returned list, or is missing or unreadable while the list fills the guest
window, the result sets `history_truncated: true`, so a tracker with universal
providers enabled can still look for the full history. A history known to be
cut also gains its acceptance as the oldest event: the collector record's time
and office, earlier than every returned scan, under the app's own label
`已揽收`. The receiver country label becomes `destination_country` when it is a
Chinese country name, which lets routing confirm the destination post's own
history.

Stages come from the scan code. The coarse state label (`stateDesc`) is used
only for codes without a mapping. A delivery attempt (542) keeps its own stage,
even though its state label still reads "运送中". The encrypted `mailStateSign`
is not decoded: `stateDesc` carries the same state as readable text.
`statusMap` in [status.ts](status.ts) answers the app's review queue by scan
code, and by wording only when the wording is a state label: one that replaced
a scan's text or names the dated acceptance.

The newest scan sets the status, with one exception. Like the web preview, the
guest window can show a destination office's inbound processing scan above the
delivery, uploaded after the item was delivered: arrival at or departure from
its processing centre, departure from a transit office, or arrival at the
delivery office. Such scans do not undo a delivered scan: the parcel stays
delivered under the delivery's text, while the events keep the service's order
and `last_update_local` keeps the newest scan's clock. Any other newer scan sets
the status, including one whose code is staged only by its coarse state label
and export customs at the destination, which starts a way back. A provider
history that holds the delivery and the later scan still replaces the guest
window, under China Post's status.

## Times

Each scan time is a wall clock without an offset, kept in `local_time`. Chinese
offices scan on China time, foreign posts on their own local time, and airline
handover scans have no stated zone. Because one history mixes these clocks, the
catalog timezone stays UTC with local clocks, and the adapter never sets
`last_update`.

## Privacy

The reply also carries the collector, deliverer and operator names and phones,
masked sender and receiver cities, the receiver's arrival city, notes, map
traces and courier photo links. None of these is read; of the collector
record, only its time and office are, for the acceptance event. Domestic EMS
scan texts embed courier names, mobile numbers and branch phones, so each text
is cut at its first clause. A text that still names a person, a phone, a signer or
an unrecognised bracketed value is replaced by its state label: a return to
sender (711) reads "已退回".

## Limitations

- "暂无物流信息" (no logistics information) answers unknown, unscanned and
  expired numbers alike, and also real registered (`R…CN`) and `U…CN`
  letter-post items this backend does not serve. It is inconclusive, never not
  found, and the adapter does not implement recognition.
- A request for the phone digits ends the lookup as `input_required`.
- Full history needs a signed-in account: `subjection/v2` answers guests with
  "请登录后再查询" (sign in first). Accounts are not used.
- The EMS partner API requires issued customer credentials and is not used.

## Testing

Fixtures are synthetic. The live test checks that an unused, well-formed number
stays inconclusive, which also shows that the signature is accepted. It runs a
positive lookup when `CHINA_POST_TRACKING_NUMBER` is set outside Git:

`CHINA_POST_TRACKING_NUMBER=<number> npm run test:carriers:live -- carriers/china-post`
