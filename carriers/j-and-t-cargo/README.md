# J&T Cargo

J&T's Indonesian freight network for large consignments, a separate company and tracking
system from [J&T Express](../j-and-t/README.md). Link only: the app recognizes the number
and opens J&T Cargo's tracking page.

## Why there is no automatic tracking

The tracking page asks for the last four digits of the sender's or recipient's phone
number before it looks a waybill up. A number alone returns nothing, there and through
the universal providers.

## Notes

The [official page](https://www.jtcargo.id/networkQuery) publishes its tracking
requests under `https://office.jtcargo.co.id/official/waybill/`.
`trackingIsNotEmpty` opens verification; `trackingValidate` submits the
waybill and the supplied four digits as `validateCode`. The page then resolves
pieces with `getMainSubBillCode` and reads scans through
`trackingCustomerByWaybillNo`. Its client permits an empty account token.
An adapter still needs the user's phone digits, verified lookup state and an
exact identity for the requested master or piece; it cannot infer them from
the waybill.

- Waybills are twelve digits. Every public report but one starts with `20`, so that prefix
  suggests J&T Cargo among the carriers sharing twelve digits. It never selects it.
- A consignment of several pieces has one master waybill; a piece adds three digits to it.
  Only the master is suggested.
- A pasted `jtcargo.id` tracking link names the carrier and carries the waybill.
