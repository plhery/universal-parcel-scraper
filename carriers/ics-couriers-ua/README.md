# ICS Couriers

ICS Couriers parcels use enabled universal providers. There is no dedicated adapter.

ICS Couriers, ТОВ «Інтернешнл Кур'єр Сервіс» (International Courier Service) of Kyiv, is a
Ukrainian international express carrier and forwarder for documents, parcels and freight by air,
road, rail and sea, cleared through its own customs terminal.

## Numbers

Its tracking page takes a shipment's tracking number. No public page shows a whole number or its
layout, so there is no rule.

## Why there is no adapter

Its tracking page is a white-label of the tracker of PSP-Express, another Ukrainian international
carrier: it asks PSP-Express's service for the shipment under a path named for ICS, and shows its
dated scans with their country and region. With no public number to check its replies against,
there is no adapter.

## Leads

`https://my.psp-express.com/api/ics-couriers/shipment/{number}` answers a GET with JSON: the
shipment's statuses, each with its time, country and region.

## Links

Its tracker takes numbers only through its form, so no address opens one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
