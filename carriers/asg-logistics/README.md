# ASG Logistics

Select ASG Logistics and enter an air waybill or delivery order from its [public cargo tracker](https://www.asgl.vn/en/tracking). A master air waybill has an airline prefix and eleven digits in total. A ten-digit reference uses the delivery-order lookup, and an alphanumeric house air waybill uses the house lookup. The guest lookup leaves the phone field empty.

The adapter confirms the complete reference in the returned master shipment, delivery order or house movement row. It keeps carrier wording that reports delivery, a departure or a facility code. It suppresses staff names, vehicle details and other free text. The house reply stamps its lookup using the current clock. The tested master and delivery-order replies show a day and month without a year. The adapter exposes these replies as shipment summaries and leaves the event time unset.

The tracker publishes `AASEL2632082`, `180-54765771`, and `7337627075`. The native guest service returned an exact result for each on November 20, 2026.

```sh
ASG_LOGISTICS_TRACKING_NUMBER=AASEL2632082 ASG_LOGISTICS_UNKNOWN_NUMBER=ASGLUNKNOWN000 npm run test:carriers:live -- carriers/asg-logistics
```
