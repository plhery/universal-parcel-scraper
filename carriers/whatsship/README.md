# WhatsShip

Tracks WhatsShip forwarding references through the guest JSON endpoint called by [its branded tracker](https://www.whatsship.com/). Recognition confirms the whole order reference before choosing the carrier.

The `direct` step calls the tracker’s 57track backend; `retry` repeats only a network failure. This integration follows WhatsShip references only. The backend’s partner waybills do not establish another carrier’s ownership.

The parser keeps dated scans and their stated offsets. Scans without an offset retain their local wall clock. Scans carry WhatsShip's node code, which names the step; the feed relayed for some partners' orders, such as YunExpress's, has no code, and its shared English wording names the step instead. The response’s metadata timestamp is neither a scan nor an estimate. An exact missing-number reply is absence; empty history, malformed replies and verification remain distinct.

The website substitutes demo history when its API fails, so rendered results are not used. Proof-of-delivery links, contacts and partner aliases are omitted. Accounts and other reference families are outside this route.

`npm run test:carriers:live -- carriers/whatsship`
