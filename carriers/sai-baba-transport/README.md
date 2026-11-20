# Sai Baba Transport

Select Sai Baba Transport and enter the carrier’s eight-digit lorry receipt in its [guest tracker](https://www.saibabatransport.com/track). The adapter reads the JSON used by that page and verifies the whole receipt in the reply.

The carrier gives day-first movement dates without times. The adapter keeps the calendar dates and records the branch identified by each movement. It excludes contact details, cargo, vehicle identifiers and delivery forecasts. An `OUT` movement is a transfer between branches. A `DELIVERY` movement identifies delivery by the listed branch.

The carrier publishes `40018310` in its tracking form. Its live lookup returned four dated movements on November 20, 2026.

```sh
SAI_BABA_TRANSPORT_TRACKING_NUMBER=40018310 SAI_BABA_TRANSPORT_UNKNOWN_NUMBER=00000000 npm run test:carriers:live -- carriers/sai-baba-transport
```
