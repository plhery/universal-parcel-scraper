# Saee

Saee parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Saee waybills are `OS`, eight digits and `KS`. `saee-1` claims that shape; archived lookups on
Saee's tracking page show no other layout for its shipments.

## Links

The tracking form opens one waybill from `saee.sa/en/track-your-shipment?waybill={number}`.
Older links use `trackingnum` on `saee.sa/trackingpage`; the library reads both.

## Retrieval limits

The public tracking form and legacy publisher host return HTTP 503. The Android
package `com.saee.customers` is listed as [HalaBag](https://play.google.com/store/apps/details?id=com.saee.customers),
a luggage service from BAGGAGE SOLUTIONS COMPANY. That listing does not establish coverage
of Saee’s historical waybills. Other similarly named apps are not a supported source for
this Saudi network.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
