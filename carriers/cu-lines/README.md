# CU Lines

China United Lines (中联航运) is the Shanghai container line. Tracked through the eService its
website's tracking page reads, for a booking, a bill of lading or a container.

## How it works

1. `direct` posts the tracking page's forms to `https://eservice.culines.com/gnoss/CUP_HOM_3301GS.do`:
   - a booking or bill: its containers, `f_cmd=121&search_type=B&search_name=`; then the moves of
     its first three containers, `f_cmd=125&cntr_no=&bkg_no=&cop_no=`;
   - a container: the bookings it travelled under, `f_cmd=122&cntr_no=`; when there are several,
     its rows, `f_cmd=121&search_type=C&search_name=`, date the latest; then its moves in that
     cycle.
2. `retry` asks once more when a request did not reach CU Lines.

No account, cookie, token or CAPTCHA is needed. The website also offers a `/search/getCommon`
proxy to the same service; it is not used because it fetches whatever address it is given.

## Notes

- A reply must succeed with an empty `Exception`. Only a success with a zero count and nothing
  else is a number CU Lines does not hold; an error, a page in place of JSON or a missing address
  is not. A booking's rows must name the booking asked, and each move must carry the reference of
  the cycle asked, since the move list answers for the cycle whatever container it names.
- Moves CU Lines only estimates are left out. Stages follow the move codes, as the wordings name
  vessels; they are in [statuses.json](statuses.json).
- The return of the empty container is the delivery, and a full container withdrawn for the
  consignee goes out for delivery. An empty container returned before it moved is an unused one,
  and a gate in after the container moved is transit.
- A booking's containers move apart. The booking is delivered once every container is back; until
  then the latest open stage leads. The containers past the first three keep the latest move of
  the booking search, and the history is marked truncated.
- Times are wall clocks: CU Lines gives the place's time without its zone.
- Estimated dates, vessels, voyages, seals and weights are not read.

## Limitations

- A container lookup returns the container's latest cycle, which may be a later shipment than the
  one asked about.
- The booking search does not answer for the `SYS` numbers some bills carry, so those are refused.

## Numbers

Bookings and bills are `CUL`, four letters and seven digits: `CULV`, the port of loading's three-letter
code and a serial. Containers are ISO 6346 numbers, whose check digit is checked before the lookup.
Detection has no rule. The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/cu-lines`, with `CU_LINES_TRACKING_NUMBER` and
`CU_LINES_UNKNOWN_NUMBER` set outside the repository.
