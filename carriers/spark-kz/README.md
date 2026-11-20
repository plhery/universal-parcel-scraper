# Spark

Spark Logistics (ТОО "Spark Логистика"), based in Almaty and on the market since 2010, carries part
and full truck loads across Kazakhstan, runs fulfilment warehouses and a terminal at Khorgos, and
delivers parcels for online shops. Its site is spark.kz.

## How it works

The adapter asks Spark's order service for the waybill with plain HTTP, without a login, cookie or
CAPTCHA. The home page's tracker asks an older route of the same service, which words its steps in
Russian only; the order service's route takes a language and the adapter asks for English.

The service lists every step of the waybill's route, each marked done, cancelled or planned, with
its day. Done and cancelled steps with a day become events, newest first. A planned step's day is a
forecast and is left out. Steps carry a numeric code, which the status map reads; a code it does
not know falls back to the shared wording rules. The service's predicted delivery day is kept as
the estimate until the parcel is delivered or its pickup is cancelled.

An unknown number gets an HTTP 404 with a Russian "no statuses for the waybill" message, read as
not found. A waybill with no dated step yet is read as listed without history.

## Numbers

Spark's waybill numbers read `SP` and eight digits. The shape is shared with other carriers, so
there is no rule.

## Limitations

Steps are dated to the day, without a time or place. The service also returns the cash-on-delivery
sum and the payment status, which the adapter leaves out.

## Links

The tracker has no per-shipment address, so there are no tracking links.

## Testing

```sh
npx vitest run --config vitest.carriers-live.config.ts carriers/spark-kz
```

`SPARK_KZ_TRACKING_NUMBER` replaces the public sample.
