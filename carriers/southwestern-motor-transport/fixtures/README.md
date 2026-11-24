# Fixtures

Screens of SMT's Profound UI Shipment Tracing program (`profoundui.smtl.com/profoundui/PUI0001200.pgm`),
as JSON. Each is trimmed to the session, the trace screen's fields and its subfiles: the layout, the server's
job details and the translations are left out, and the session id is a placeholder.

- `opened.json`: the screen a new session opens on, before any trace.
- `delivered.json`: the screen after a trace of the public sample in [`numbers.json`](../numbers.json), freight
  picked up in Houston and delivered in Angleton, Texas. The signer's name, the bill of lading and the purchase
  order are placeholders.
- `no-shipment.json`: the screen after a trace of an invented PRO, on a new session: the entry is cleared and
  nothing else is shown.
