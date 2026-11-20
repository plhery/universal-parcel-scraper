# Confirmed Freight

Select Confirmed Freight and enter the shipment reference from the carrier’s tracking link. The adapter uses the carrier’s HTTPS shipment result page and checks the reference in the manifest. The separate reusable equipment case lookup is outside the adapter’s scope. [Official tracker](https://www.confirmedfreight.com/services/tracking.htm)

The site groups movement rows under a date and prints minute-precision clocks without offsets. The adapter carries the date down to the group’s rows, uses the last dated movement for current status and keeps shipment staff, addresses, schedules and maps out of the result. The carrier’s anonymous shipment demonstration was available live and returned five dated movements. It is the only positive sample used here. [Official shipment example](https://www.confirmedfreight.com/track/SAMPLE/)

```sh
CONFIRMED_FREIGHT_TRACKING_NUMBER=SAMPLE CONFIRMED_FREIGHT_UNKNOWN_NUMBER=NO-CF-GUIDE-000000 npm run test:carriers:live -- carriers/confirmed-freight
```
