# Airspeed

The native adapter reads the anonymous cargo tracker at
`logistics.airspeed.com.ph/track/TrackingSearch.aspx?waybill=…` for its supported waybills.
The separate shipment number must match whole, and the current status and clock must agree with
an end of the history grid. Explicit selection, tracking links and supported handoffs reach it;
there is no broad numeric detection or recognition rule.

The grid keeps local month/day clocks, newest first in the result, without an assumed offset.
A pickup request precedes custody, and preparing a manifest records no movement. The combined
location/remarks column can contain receiver and proof details, so it is omitted together with
references and destination details. No estimate is inferred from the booking date.

An empty tracker view also supplies the server's current clock as its booking date. That date
proves no booking; the empty view remains inconclusive because it supplies no bound shipment or
explicit absence notice. Refusals, rate limits and malformed replies stay distinct, with enabled
provider fallback available.

Retrieval uses verified HTTPS, the caller's transport, cancellation and aggregate budget, with
one network-only retry. No session or browser bootstrap is needed.

Run `AIRSPEED_TRACKING_NUMBER=… AIRSPEED_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/airspeed/adapter.live.test.ts` with private inputs.
