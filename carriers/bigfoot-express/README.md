# Bigfoot Express Freight

Bigfoot Express Freight parcels use enabled universal providers. There is no dedicated adapter.

Bigfoot Express Freight is a break-bulk express road freight carrier based in Durban, with depots
across South Africa and deliveries to Botswana, Lesotho, Eswatini, Namibia, Zambia and Zimbabwe. Its
site is bigfootexpress.co.za.

## Numbers

Public examples are nine characters: three letters and six digits, or two letters and seven. Only an
aggregator's examples show them, so there is no rule.

## Why there is no adapter

Its tracker is a ParcelPerfect app that keeps the searched waybill in the browser's storage and
posts it as JSON to `trackappservice/Json/index.php` with class `Waybill` and method `getEventData`.
No found reply has been seen.

## Links

The app takes the waybill in its form and keeps it in the browser, so no address opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
