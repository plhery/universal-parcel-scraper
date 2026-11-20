# IBEX Express

IBEX Express delivers freight and parcels in Bolivia. The [public tracker](https://www.ibex.com.bo/)
takes the guide number. For an electronic waybill, enter the digits after the hyphen, as
shown on the carrier's form.

The adapter reads `GET /forms/rastreo.php?guia=…` and verifies the requested waybill on every
row. It keeps the scan dates, local clock times and depot names. The tracker records actual
delivery separately from the scan log. When the summary says delivered, the adapter emits
that observed timestamp alongside the history. The delivery estimate, parcel contents,
personal details and proof of delivery are outside its scope.

Set `IBEX_EXPRESS_BO_TRACKING_NUMBER` and run
`npm run test:carriers:live -- carriers/ibex-express-bo` to verify a sample.
