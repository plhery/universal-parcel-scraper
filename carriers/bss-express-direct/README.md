# BSS Express Direct

The [public tracking form](https://www.bssexpressdirect.com/track) uses the
receipt number BSS issues when collecting a shipment for Haiti. Select BSS
Express Direct and enter the printed reference.

The adapter requests the same public data as the results page. It reads the
response's data fields, checks that the returned receipt matches and keeps
dated tracking events with the offsets supplied by BSS. The public example
confirms collection. Status labels for other stages come from the carrier's
English tracker. The fixtures retain status and event fields.

Run the live test with `BSS_EXPRESS_DIRECT_NUMBER` set and
`npm run test:carriers:live -- carriers/bss-express-direct`.
