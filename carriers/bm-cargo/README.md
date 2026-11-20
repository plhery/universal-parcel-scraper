# BM Cargo

BM Cargo forwards purchases to the Dominican Republic. Select BM Cargo explicitly and
enter its warehouse receipt number. The adapter restores the hyphen printed on the receipt.

## Retrieval

The [public form](https://www.bmcargo.com/) opens the iPlus status page with the receipt in
its query. The adapter reads the displayed receipt number and its dated scan table.
An empty tracking form gives no result and cannot distinguish an expired receipt from an
unknown one. Store-issued tracking numbers can return a different warehouse receipt, so the
adapter accepts only a BM Cargo receipt.

The timeline has Spanish status wordings and the scanning locations. Its clocks have no
offset and span multiple countries, so the adapter keeps them as local times. It reads
the dated rows and skips the progress bar's labels, which include unreached milestones.

## Testing

`BM_CARGO_TRACKING_NUMBER=… BM_CARGO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/bm-cargo`
