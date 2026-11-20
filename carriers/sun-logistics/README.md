# Sun Logistics

Sun Logistics operates first- and last-mile freight services in New York and South Florida. Select Sun Logistics explicitly and enter the PRO number from the freight bill.

The [carrier’s public form](https://sunlogistics.com/) opens the numbered Carrier Logistics page using `startpage=protrace` and `pronum`. The adapter verifies the numbered shipment heading, then reads the shipment history and its status summary.

The carrier displays local scan times and sometimes a city and state. Appointment updates retain their scan time and omit the scheduled window. The adapter discards street addresses, receiver information, signatures, and proof-of-delivery links.

Run the live test with the publicly indexed PRO number.

```sh
SUN_LOGISTICS_TRACKING_NUMBER=33807093 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/sun-logistics/adapter.live.test.ts
```
