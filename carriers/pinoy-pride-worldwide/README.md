# Pinoy Pride Worldwide

Select Pinoy Pride Worldwide and enter the invoice number. The adapter restores separators in the published standard and Returning Resident forms, queries the carrier’s public lookup and verifies the returned invoice. [Official tracker](https://pinoyprideworldwidellc.com/tracking)

The adapter reads the carrier’s dated movements at minute precision. It omits proof records, remarks, sender and receiver names, and document verification. The published Returning Resident invoice shows container loading, a customs milestone and final delivery.

```sh
PINOY_PRIDE_TRACKING_NUMBER=PPW-WA-RR-1001 PINOY_PRIDE_MISSING_NUMBER=PPW-WA-1001 npm run test:carriers:live -- carriers/pinoy-pride-worldwide
```
