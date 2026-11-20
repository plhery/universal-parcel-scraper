# Ou Yi Hang International Logistics

Select Ou Yi Hang International Logistics and enter the waybill in its [guest tracker](https://oyh-exp.com/en/tracking). The adapter reads the JSON used by the form and verifies the full waybill in the reply.

The portal provides movement dates and UTC offsets. The adapter uses each stated offset, including the carrier’s UTC+08:00 clock on some European freight movements. It preserves a wall clock if the offset is absent. Status code `ND` identifies a shipment in transit. Forecast dates in movement wording do not create delivery events or estimates. The adapter retains movement locations and omits partner references, transit-day counters and signatory data.

The carrier’s published demonstration waybill returned 17 dated movements on November 20, 2026. [Official tracking form](https://oyh-exp.com/zh/tracking)

```sh
OU_YI_HANG_TRACKING_NUMBER=OYH1000194068 OU_YI_HANG_UNKNOWN_NUMBER=OYH0000000000 npm run test:carriers:live -- carriers/ou-yi-hang
```
