# Peshkariki

Peshkariki parcels use enabled universal providers. There is no dedicated adapter.

Peshkariki (Пешкарики), ООО «ДОСТАВКА-СЕРВИС», is a Russian on-demand courier service with couriers
on foot and by car, for shops and people in Moscow, St Petersburg, Yekaterinburg, Krasnodar,
Chelyabinsk, Nizhny Novgorod and Kazan.

## Numbers

Its tracker takes an order number of 5 to 12 characters. No public page shows a whole number, so
there is no rule.

## Why there is no adapter

The tracker asks for the phone number given with the order as well as the order number. With no
public number to check its replies against, there is no adapter.

## Leads

The page posts the order number and the phone to `/eApis/frontend/orderTracking/searchOrders`.

## Links

The tracker takes the number only with the phone, so no address opens one order and the catalog
sends people to the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
