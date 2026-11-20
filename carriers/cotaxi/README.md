# COTAXI

Select COTAXI and enter the full guide, such as a branch prefix followed by a hyphen and the serial. The official guest form sends the two parts separately and returns a tracking PDF. The adapter reads the bounded report content stream and verifies the full guide next to `NUMERO GUIA`. [Official tracker](https://www.cotaxi.com.co/)

The report prints all traceability stages, including future stages with empty clock fields. Only boxes with printed clocks become events. Vehicle assignment is administrative. `SALIENDO A DISTRIBUIDOR` can describe a handoff to a distributor, so its stage remains unmapped. The report clocks carry no offset. The parser uses the tracking panel’s status and clock fields, and the fixtures contain only the identity and traceability data needed to replay it.

```sh
COTAXI_TRACKING_NUMBER=… COTAXI_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/cotaxi
```
