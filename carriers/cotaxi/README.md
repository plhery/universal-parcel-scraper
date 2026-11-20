# COTAXI

Select COTAXI and enter the full guide, such as a branch prefix followed by a hyphen and the serial. The official guest form sends the two parts separately and returns a tracking PDF. The adapter reads the bounded report content stream and verifies the full guide next to `NUMERO GUIA`. [Official tracker](https://www.cotaxi.com.co/)

The report prints all traceability stages, including future stages with empty clock fields. Only boxes with printed clocks become events. Vehicle assignment is administrative. `SALIENDO A DISTRIBUIDOR` can describe a handoff to a distributor, so its stage remains unmapped. The report clocks carry no offset. The parser uses the tracking panel’s status and clock fields, and the fixtures contain only the identity and traceability data needed to replay it.

Both guides printed in COTAXI’s fourth-quarter 2025 report returned dated movements. [Carrier’s published shipment report](https://www.cotaxi.com.co/wp-content/uploads/2026/09/CUARTO-TRIMESTRE-2025.pdf)

```sh
COTAXI_TRACKING_NUMBER=RCFEB-4805 COTAXI_UNKNOWN_NUMBER=ZZZZZ-00000000 npm run test:carriers:live -- carriers/cotaxi
```
