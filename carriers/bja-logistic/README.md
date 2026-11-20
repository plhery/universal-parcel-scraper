# BJA Logistic

Select BJA Logistic and enter the BJA No. printed on the shipment slip or
invoice. The [carrier's tracker](https://bjalogistic.id/cek-resi) instructs
customers to omit leading zeros. The adapter normalizes them before lookup.

The public reply gives calendar dates in Indonesian, without clock times.
The adapter preserves those dates, the shipping service and the estimated
arrival day when present. It retains the wording `Barang Diterima` without
assigning a delivery stage because the scan does not identify who received it.

Set `BJA_LOGISTIC_NUMBER` and run
`npm run test:carriers:live -- carriers/bja-logistic` to verify a public sample.
