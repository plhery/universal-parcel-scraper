# Fastbox

Fastbox parcels use enabled universal providers. There is no dedicated adapter.

Fastbox (패스트박스, fastbox.co.kr) is a Korean fulfilment and cross-border shipping service. It
issues its own FB invoice for a parcel and hands it to a postal or courier partner abroad, often
EMS.

## Numbers

An FB invoice is `FB` and sixteen digits, the format Fastbox's tracker asks for. In every public
invoice the six digits after `FB` are a date (year, month, day), so `fastbox-1` requires one there.
No other carrier's rule or sample takes the layout, so the rule has high confidence.

## Tracker

`GET https://fastbox.co.kr/DHUB/tracking.php?fb_invoice_no=` answers without a cookie, key or
CAPTCHA. A known invoice gets a server-rendered page: the destination country, the partner's name and
its domestic invoice number, then dated rows of a status, a place, the partner and its text, relayed
from the partner. An unknown invoice gets the bare search form. The page also prints the recipient's
name and address, which an adapter must not read.

## Links

The tracker page takes the invoice in `?fb_invoice_no=`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
