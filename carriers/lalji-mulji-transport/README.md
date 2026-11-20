# Lalji Mulji Transport

Lalji Mulji Transport carries parcels and part-load freight by road across India.
Its public [Track & Trace page](https://lmtco.com/tracking-serices.html) looks up
one lorry receipt per request through the carrier's iVCargo tenant at `lmterp.com`.
The adapter uses the same public JSON endpoint and checks the lorry receipt
number on every movement. The carrier's public page takes the number in its form.

The adapter reads the dated movements, branch names, and actual weight. The
movement clocks are in the carrier's local India time. `RECEIVED` means a depot
received the shipment. The fixtures retain the tracking fields of two lorry
receipts published in a consumer commission judgment. Their branch, booking date,
and weight agree with the published shipments. Branch addresses and contact
information are omitted.

`LALJI_MULJI_TRACKING_NUMBER=22175354 npm run test:carriers:live -- carriers/lalji-mulji-transport`
