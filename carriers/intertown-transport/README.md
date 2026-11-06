# Intertown Transport

Intertown Transport parcels use enabled universal providers. There is no dedicated adapter.

Intertown Transport (ITT) is a courier and road and air freight carrier based in Gqeberha, with
branches and agents across the Eastern, Western and Southern Cape, the Garden Route, the Karoo and
Johannesburg. Its site is intertown.co.za.

## Numbers

The public example is eight digits. Eight bare digits fit many carriers' numbers, so there is no
rule.

## Why there is no adapter

Its tracker is the same ParcelPerfect app as
[Bigfoot Express Freight's](../bigfoot-express/README.md): it keeps the searched waybill in the
browser's storage and posts it as JSON to `trackappservice/Json/index.php` with class `Waybill` and
method `getEventData`. No found reply has been seen.

## Links

The app takes the waybill in its form and keeps it in the browser, so no address opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
