# PTT

Tracks PTT items, PTT Kargo parcels and international mail among them, through the anonymous
shipment query of PTT's own mobile app.

## How it works

The app posts the barcode as JSON, `{"barkod": number}`, to
`https://pttreklamws.ptt.gov.tr/PttBirlesikMobil/takip/gonderiSorgulav2`. The adapter sends that
one request with `Accept-Language: tr`: for other languages the service words its notices in
English, while scans stay Turkish. No account, cookie, key, token or browser is needed. A
request that fails to reach PTT is sent once more within the budget.

The reply carries a result code and must name the whole requested barcode. Code 1 with the
notice "Girilen barkoda ait hareket bulunmamaktadır.", or its English form, is the only missing
item; another notice or code stays indeterminate. Code 2, "Geçersiz Barkod.", is a
barcode PTT rejects. A redirect is PTT's firewall turning the request away to its home page and
is a challenge. Block pages, empty replies, HTTP errors and malformed replies keep their own
failure kinds. Recognition uses the same lookup.

The tracking window on `www.ptt.gov.tr` reads a different service on `api.ptt.gov.tr`: an
invisible Cloudflare Turnstile check, whose token `POST /api/TrackingToken` exchanges for an
`X-Tracking-Token` header, then `POST /api/ShipmentTracking` with the number as a JSON string.
`gonderitakip.ptt.gov.tr` redirects to that home page. The adapter reads neither.

## Numbers

PTT Kargo numbers are `KP` and eleven digits or thirteen digits; international items use the UPU
S10 layout. The app's field takes thirteen characters. The adapter takes `KP` numbers, thirteen
digits and S10 codes with a valid check digit, from any country; anything else is invalid
without a request. The service itself does not check S10 or EAN check digits and answers a
mistyped code as having no movements.

`ptt-1` claims the `KP` shape. A code ending `TR` is PTT's, but the issuer of an S10 code does
not establish who delivers it, so detection keeps such codes with the generic postal carrier and
the low-confidence `ptt-s10` rule makes preflight ask PTT about them. Thirteen digits are shared
with several carriers, so no rule claims them.

## Notes

Each scan carries PTT's Turkish wording and no code, the status in capitals with a reason or a
relayed foreign event around it. The adapter maps the wording with Turkish letters folded to
Latin ones; wording the map does not know goes to the shared wording rules. A delivery names
after a slash who signed for the item, masked. The scan keeps that name and the map reads the
wording before it. The reply's masked recipient name is read, and so is the masked name of who
took a delivered item. Its masked sender name, postage and offices of acceptance and delivery
are not.

Scan clocks carry no offset and are kept as local times. Domestic scans are on Turkish time;
the events a foreign post relays for an item sent abroad are on that post's clock and name the
country instead of an office.

The pickup point is the office named by "PTT İŞYERİNDE", where an item waits after a failed
delivery, while it waits there or once it was collected there. An office holding an item nobody
collected, "(MEVKUF)", is an exception. The weight is given in grams and kept in kilograms.

17TRACK relays PTT's statuses in its own English, such as "PTT in the workplace" for "PTT
İŞYERİNDE" and "Distribution" for "DAĞITIMDA". Rules scoped to PTT
([scoped.ts](../../core/status/scoped.ts)) read those renderings as PTT's map reads the Turkish.
ParcelsApp relays some in another English without naming PTT, such as "Handed to the delivery
person"; the providers' wording rules read those.

## Limitations

The app's service accepts connections only from Turkish networks, and so does the website's
`api.ptt.gov.tr`: elsewhere the connection times out or is reset, which stays a network failure
rather than a missing item. Tracking from outside Turkey needs a Turkish egress.

Items from abroad by their foreign S10 code have not been seen with live history. The reply has
no estimated delivery date or service name.

## Links

The link opens PTT's home page. Its tracking window asks for the number, so no link opens one
parcel.

## Live test

Set `PTT_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/ptt/adapter.live.test.ts`.
Optionally set `PTT_UNKNOWN_NUMBER` to check a barcode without movements.
