# Aeroméxico Cargo

[Aeroméxico Cargo](https://amcargo.aeromexico.com/) operates air freight services. Select Aeroméxico Cargo and enter its 139-prefixed air waybill.

The [public tracker](https://amcargo.aeromexico.com/track/) looks up the waybill at `GET /back-office/api/track/v3/139/{serial}`. It returns an IATA Cargo-IMP FSA message with the waybill repeated before each movement. The adapter checks each association and reads the carrier's movement codes. A full-load delivery closes the shipment. Delivery of a subset of pieces remains in transit.

The [Aeroméxico label-printing guide](https://www.cmsgsa.com/formularios/AM/AM%20-%20Gu%C3%ADa%20de%20impresi%C3%B3n%20de%20etiquetas%20para%20carga.pdf) shows the sample waybill. Its live reply contains 17 movement records. These messages supply days and months without years. The event text retains the reported day and clock. The search link opens the guest form.

```sh
AEROMEXICO_CARGO_AWB=139-43814223 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/aeromexico-cargo/adapter.live.test.ts
```
