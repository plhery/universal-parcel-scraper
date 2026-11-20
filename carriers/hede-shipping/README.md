# Hede Shipping

Select Hede Shipping and enter an equipment number in its [cargo tracker](http://elines.hedehk.com/cargoDynamicEN). This adapter reads the native HTTP equipment form. The [Hede community portal](https://hede.orcapayments.app/container-tracking/) provides an HTTPS tracking form for manual lookup.

The native lookup echoes the complete container number and includes dated movements under that equipment. The adapter uses those rows across voyages. It keeps their port clocks as printed. Vessel and terminal movement dates in the bill summary can be estimates, and an equipment gate-out or empty return does not establish the consignee's delivery.

The [public manifest](https://es.importgenius.com/importers/cn-link-freight-services-inc) lists `FFAU7750036` under Hede's bill. The native equipment search returned 16 dated movements on November 20, 2026.

```sh
HEDE_SHIPPING_TRACKING_NUMBER=FFAU7750036 HEDE_SHIPPING_UNKNOWN_NUMBER=ABCU0000000 npm run test:carriers:live -- carriers/hede-shipping
```
