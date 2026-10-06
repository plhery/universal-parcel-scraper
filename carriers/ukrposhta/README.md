# Ukrposhta

Tracks domestic barcodes and international postal references through Ukrposhta's
status API and the official consumer tracker, including the destination post's
scans when it supplies them.

## How it works

`direct` asks the status API that Ukrposhta's Android app uses, over plain HTTP.
The app's shared application bearer is included; consumers need no key setup.
`UKRPOSHTA_TRACKING_TOKEN` can replace it.
The reply is a list of scans, each naming its barcode and its position in the
history. Every row must name the requested barcode.

`browser` is the fallback. A fresh anonymous browser submits the same reference
twice through the native batch form. That response supplies an exact barcode, the
current scan and a history count. A single-reference query then supplies full
history. The adapter requires the count and current scan to agree across both
replies before accepting history. The browser completes the portal's automatic
verification; interactive challenges remain failures. No account, saved browser
profile or recipient details are used.

## Mobile app

The endpoint comes from the Android app `ua.ukrposhta.android.app`:
`GET https://www.ukrposhta.ua/status-tracking/0.0.1/statuses` with `barcode` and
`lang`, and an `Authorization: Bearer` header carrying one credential shared by
every install. A request without it, or with one Ukrposhta has retired, gets an
HTML refusal. The adapter treats that as a challenge and the browser takes over.

The newer Flutter app `ua.ukrposhta.ukrposhta` tracks through account routes on
`my.ukrposhta.ua` and offers no guest lookup.

## Notes

The status API orders scans by position and its clocks include seconds. On the
portal the batch clock includes seconds, while full history has minute precision;
matching uses that shared precision. All offsetless scan clocks remain local,
including foreign scans, and retain native order. See [ROUTING.md](https://github.com/plhery/delivery-tracker/blob/main/docs/ROUTING.md)
for unresolved history handling. A return decision starts a separate leg; later
transport remains active until a delivery scan completes that leg.

Both sources read the same domestic records. When the status API does not know a
domestic barcode the browser is not asked. An international reference still gets
the portal, which also shows the destination post's scans.

## Limitations

Detection only suggests Ukrposhta for a thirteen-digit domestic barcode, a length
other carriers share. International references follow the issuing post.
The fallback needs `TRACKING_CHROMIUM_PATH`. Neither
not-found reply names the barcode, so neither can establish parcel absence. On the
portal, multiple-piece shipments, count changes between requests and conflicting
current scans are inconclusive. Delivery and estimate dates are not inferred from
local scan clocks or the query time. The portal can refuse the browser's automatic
verification. The lookup then fails as a challenge and routing falls back to the
universal providers.

## Testing

Run `npm run test:carriers:live -- carriers/ukrposhta`. `UKRPOSHTA_TRACKING_NUMBER`
adds a positive lookup and `TRACKING_CHROMIUM_PATH` the browser checks; supply both
outside the repository.
