# Sunrise Logistics Group

[Sunrise Logistics Group](https://www.sunriselg.com/) operates freight services in Colombia. Select Sunrise Logistics Group explicitly and enter the house air waybill.

The [guest tracker](https://tracking.sunriselg.com/es) reads the air shipment history from `GET /api/v1/seguimiento-embarques-aereo/numDoc/{reference}`. The adapter restores the dash in the published `BOG-` layout, verifies the document number on each returned row and reads up to 200 records. It uses carrier-marked current records to set the current stage.

The published house air waybill has a historical booking confirmation. Its movement date is a year-0001 placeholder. The adapter keeps the booking wording and distinguishes a record insertion time from an actual movement date. This adapter covers the house air waybill lookup.

```sh
SUNRISE_CO_TRACKING_NUMBER=BOG-110491 SUNRISE_CO_UNKNOWN_NUMBER=DO-2025-0087 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/sunrise-logistics-colombia/adapter.live.test.ts
```
