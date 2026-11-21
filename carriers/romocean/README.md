# Romocean

Romocean is the Romeu group's NVOCC from Spain and Portugal to Morocco, Algeria and Tunisia. The
adapter tracks its bills of lading through the movement search its tracking page embeds from the
group's Shippy portal.

## How it works

1. `direct`: the portal's movement search, which the page calls with no session or CAPTCHA. A bill
   search returns each of the bill's containers with its whole history. A search that fails to reach
   the portal or times out gets one `retry`.

## Notes

- A container's history holds its other trips too, and the tracker files some moves under another
  bill or none. A bill's moves run from the first move that names it to the last, including moves
  filed between them under another bill, then the consignee's collection and the empty return that
  follow without a bill. A bill whose containers hold no move under it is listed without history.
- A bill is delivered once every container with a move has been collected or returned empty. The
  containers' shared moves at one minute and port are kept once.
- Moves carry a wall clock without an offset, so events set `local_time`; the page shows only their
  day. Locations are the UN/LOCODEs the tracker gives.
- A search with no container is the tracker's answer for an unknown bill.

## Limitations

- Container and booking searches are not used: a container's history spans many shippers' bills.
- The vessel voyages some moves carry, and the containers' numbers and types, are not kept.

## Testing

`ROMOCEAN_TRACKING_NUMBER=<bill> ROMOCEAN_UNKNOWN_NUMBER=<invented bill> npm run test:carriers:live -- carriers/romocean`
