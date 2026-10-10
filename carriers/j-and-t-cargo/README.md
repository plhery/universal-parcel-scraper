# J&T Cargo

J&T's Indonesian freight network for large consignments, a separate company and tracking
system from [J&T Express](../j-and-t/README.md). The integration is link only: it opens
J&T Cargo's tracking page. Automatic history retrieval would be an upgrade.

## Retrieval

The [official page](https://www.jtcargo.id/networkQuery) asks for the last four digits
of the sender's or recipient's phone number before loading history. Its client calls
`trackingIsNotEmpty`, submits those digits through `trackingValidate`, resolves pieces
with `getMainSubBillCode`, then reads scans through `trackingCustomerByWaybillNo`.

The [history endpoint](https://office.jtcargo.co.id/official/waybill/trackingCustomerByWaybillNo)
also accepts anonymous `POST` requests with the waybill, language and search mode.
These reads require no phone digits, account token, cookies or preceding verification
call. The phone prompt belongs to the website flow rather than this history route.

## Identity

A history's `keyword` and every scan's `billCode` must match the whole requested
identifier. Master and piece histories can differ and must remain separate.
The [mapping endpoint](https://office.jtcargo.co.id/official/waybill/getMainSubBillCode)
lists `mainBillCode`, `subBillCodes` and `count`; when queried with a piece, it can retain
that piece as `mainBillCode`. Resolve published identifiers without inventing piece
suffixes or replacing a requested piece with its master.
