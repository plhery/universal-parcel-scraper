# Cadena Courier

Select Cadena Courier and enter the numeric guide. The carrier’s guest search posts the guide and opens its matching result row. The adapter checks the guide in the list and again in the detail panel. [Official tracker](https://guias.cadena.com.co/tracking/consulta.aspx)

The adapter reads the dated event grid and keeps the carrier’s Bogotá local clocks. It leaves out recipient details, map and proof-of-delivery requests. The public court sample is present in the live tracker with only a guide creation event. The carrier’s displayed history determines the result.

```sh
CADENA_COURIER_TRACKING_NUMBER=2161247895151 CADENA_COURIER_MISSING_NUMBER=16692486 npm run test:carriers:live -- carriers/cadena-courier
```
