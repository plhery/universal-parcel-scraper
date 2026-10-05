# J&T Cargo

J&T's Indonesian freight network for large consignments, a separate company and tracking
system from [J&T Express](../j-and-t/README.md). Link only: the app recognizes the number
and opens J&T Cargo's tracking page.

## Why there is no automatic tracking

The tracking page asks for the last four digits of the sender's or recipient's phone
number before it looks a waybill up. A number alone returns nothing, there and through
the universal providers.

## Notes

- Waybills are twelve digits. Every public report but one starts with `20`, so that prefix
  suggests J&T Cargo among the carriers sharing twelve digits. It never selects it.
- A consignment of several pieces has one master waybill; a piece adds three digits to it.
  Only the master is suggested.
- A pasted `jtcargo.id` tracking link names the carrier and carries the waybill.
