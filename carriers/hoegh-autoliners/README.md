# Höegh Autoliners

Select Höegh Autoliners and enter the bill of lading. The adapter calls the carrier’s public cargo search and requires every returned cargo item to echo the full bill. [Official tracker](https://www.hoeghautoliners.com/my-cargo)

The adapter combines the cargo rows, deduplicates received and loaded events, and retains their day precision. The bill’s current stage comes from the returned cargo statuses when they all agree. The observed discharge indicates unloading from the ship. Sailing and arrival fields can include schedule information, so the adapter keeps only the dated intake and loading fields. Vehicle and contact identifiers stay out of the result.

```sh
HOEGH_AUTOLINERS_TRACKING_NUMBER=… HOEGH_AUTOLINERS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/hoegh-autoliners
```
