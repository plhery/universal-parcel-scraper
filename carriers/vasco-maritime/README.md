# Vasco Maritime

Vasco Maritime is a Singapore container line of the Goodrich Group, on the trades between Asia, the
Indian subcontinent, the Gulf and the Red Sea. The adapter tracks its bills of lading and containers
through the tracking page's booking system.

## How it works

1. `direct`: the Goodrich Group's booking system, which the tracking page calls with no session or
   CAPTCHA. `GETBLDTLS` answers a bill's header, or `GETCONTAINERDTLS` a container's, with the bill and
   voyage; `GETBLCONTAINERDTLS` then returns each of the bill's containers with the times of its moves. A
   request that fails to reach the tracker or times out gets one `retry`.

## Notes

- A move has a time and no place. Each takes the port its column refers to on the bill: the empty
  pickup the place of receipt, the gate-in and loading the port of loading, the transshipment moves the
  port of discharge when the final port differs, and the rest the final port.
- A container lookup keeps that container's moves; the page shows every container of its bill.
- A bill is delivered once every container with a move has been handed over to the consignee. The
  containers' shared moves at one minute are kept once.
- Moves carry the port's wall clock without an offset, so events set `local_time`.
- An empty reply is the tracker's answer for an unknown number. `N` is its answer for an expired
  session, which a guest request does not have, so it reads as an outage.
- The system also answers the Goodrich Group's other bills, such as Goodrich Maritime's.

## Limitations

- The vessels, the ports and the arrival estimate the page shows are not kept.
- A container lookup follows the bill the tracker gives first.
- The tracker takes about twenty seconds to find a container, so a container's first attempt gets the
  whole budget and no retry fits after it.

## Testing

`VASCO_MARITIME_TRACKING_NUMBER=<bill or container> VASCO_MARITIME_UNKNOWN_NUMBER=<invented bill> npm run test:carriers:live -- carriers/vasco-maritime`
