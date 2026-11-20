# Yang Ming

Yang Ming Marine Transport is the Taiwanese container line. Tracked through the lookup its public
cargo tracking page makes, for a bill of lading or a container.

## How it works

1. `direct` asks `https://www.yangming.com/api/CargoTracking/GetTracking` for the number, as the
   page's search does. For a bill, it then asks for the moves of its first three containers with
   the bill as reference, as the page does when a container is opened.
2. `retry` asks once more when a request did not reach Yang Ming.

The lookup answers plain HTTP from a client that names a browser; Akamai refuses the others, and
the page's retired `.aspx` tracker, with a 403. No account, cookie or CAPTCHA is needed.

## Notes

- A reply must hold one entry, for the number and kind asked. A container's moves must name the
  container.
- Yang Ming answers a number it does not hold and an address it blocks the same way. Before such a
  number is read as not found, `api/Public/GetBlockStatus` is asked whether the address is
  blocked; a blocked address is a challenge. The block lifts once the page's verification, at
  `/en/ebusiness/verify_your_identity`, takes a code of four letters from the picture
  `api/Public/GetVerify` draws, checked by `api/Public/CheckSessionVerify` against the page's
  session cookie. A recovery step could read that picture with the shared text CAPTCHA model; the
  adapter has none.
- Events are worded as DCSA's standard words them. The return of the empty container is the
  delivery, and a laden container leaving the port by truck goes out for delivery. An empty
  container returned before it moved is an unused one. Moving an empty container on a vessel is a
  repositioning, not a stage. The wordings are staged in [statuses.json](statuses.json).
- A bill's containers move apart. The bill is delivered once every container is back; until then
  the latest open stage leads. The containers past the first three keep their latest event, and the
  history is marked truncated.
- Times are wall clocks. Those at a town of the bill's route, its places of receipt, loading,
  discharge and delivery, are read in that place's zone: a US state's or Canadian province's from
  the code after the town, or the country's. Times elsewhere, and all of a container lookup's,
  keep their wall clock.
- Estimated moves and the estimated arrival are not read, nor vessels, voyages and container
  sizes.

## Limitations

- A container lookup returns the container's latest cycle, which may be a later shipment than the
  one asked about.
- A shipment listed without moves is no history.

## Numbers

Bills of lading are a SCAC of Yang Ming's, such as `YMJA` or `YMLU`, a letter and nine digits. The
page looks bills up without the SCAC, and the adapter drops it. Containers are ISO 6346 numbers,
whose check digit is checked before the lookup. Detection has no rule. The samples and their
sources are in [`numbers.json`](numbers.json). The page's link to a shipment,
`https://www.yangming.com/en/ebusiness/tracking/cargo_tracking_detail?trackNo=…`, is read as Yang
Ming's.

## Testing

`npm run test:carriers:live -- carriers/yang-ming`, with `YANG_MING_TRACKING_NUMBER` and
`YANG_MING_UNKNOWN_NUMBER` set outside the repository.
