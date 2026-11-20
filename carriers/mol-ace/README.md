# MOL Auto Carrier Express

Select MOL Auto Carrier Express and enter the 11-digit bill of lading. The adapter also accepts the `MOLU` prefix used in manifests. It posts the numeric bill through the carrier’s public search and verifies the returned bill in the result grid. [Official tracker](https://www.molace.com/TRK/Search)

The adapter keeps completed departure and arrival cells from the paired ATD / ETD and ATA / ETA columns. It retains minute precision in the carrier’s local clocks and omits scheduled movements and individual vehicle details. Port arrival is a transit movement.

```sh
MOL_ACE_TRACKING_NUMBER=… MOL_ACE_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/mol-ace
```
