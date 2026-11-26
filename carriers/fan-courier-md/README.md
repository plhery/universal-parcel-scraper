# FAN Courier Moldova

FAN Courier Moldova parcels use enabled universal providers. There is no dedicated adapter.

FAN Courier Moldova, Fan Transportation SRL of Chișinău, is a Moldovan courier for parcels and
documents, delivered across Moldova and abroad. It carries the brand of Romania's
[FAN Courier](../fan-courier/README.md) but is a separate company with a tracker of its own.

## Numbers

Its tracker finds a shipment by its AWB number. No public page shows a whole number or its
layout, so there is no rule.

## Why there is no adapter

Its tracker runs on CourierManager, a courier software platform, at app.fancourier.md. It takes
the AWB number in its address or from the home page's form, and shows the AWB's history. With
no public number to check its replies against, there is no adapter.

## Links

The tracker opens an AWB from its `awbno` parameter. Its host also serves the other
CourierManager couriers, chosen by `appcont`, and shows FAN Courier Moldova's page when the
parameter is absent, so the library reads addresses with `appcont=3895` or none.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
