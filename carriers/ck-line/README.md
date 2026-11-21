# CK Line

CK Line (Chun Kyung) is a Korean container line on the intra-Asia trades. The adapter tracks its
bills of lading and bookings through the e-service's cargo tracking page; a container number alone is
not searchable there.

## How it works

1. `direct`: the page's two JSON actions, with no session or CAPTCHA. `WESSUP411R02` lists the
   containers of a bill or booking, then `WESSUP411R03` returns each container's moves under its bill,
   for the first twelve containers. A request that fails to reach the e-service or times out gets one
   `retry`.

## Notes

- The container list takes a bill without its `CKCO` prefix, while the moves need the whole bill, so
  the adapter accepts either form and sends each action what it expects.
- An empty container's return (`TE`, `TD`) counts as delivered only when the e-service marks it for
  the import; an export's empty return keeps no stage.
- A booking is delivered once every container with a move has been returned. Moves the containers
  share, such as the vessel's departure, are kept once.
- Moves carry the port's wall clock without an offset, so events set `local_time`.
- An empty container list is the e-service's answer for an unknown number.

## Limitations

- The vessel, the ports and the arrival estimate the page shows are not kept.
- A bill with more than twelve containers is marked truncated.

## Testing

`CK_LINE_TRACKING_NUMBER=<bill or booking> CK_LINE_UNKNOWN_NUMBER=<invented bill> npm run test:carriers:live -- carriers/ck-line`
