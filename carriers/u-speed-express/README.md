# U-Speed Express

U-Speed Express (优时派), a Shenzhen cross-border logistics firm known for its overseas returns
warehouses, ships e-commerce parcels abroad, such as to Israel, where a local partner clears and
delivers them. Tracked through the guest lookup of its ITDIDA tenant, which its site serves on its
own domain.

## How it works

1. `direct`: one `GET https://www.u-speedex.com/itdida-api/queryTracks?no={number}`, the lookup
   the site's tracking page makes. It needs no cookie, token or browser; the page's other call,
   `queryYunDanDetail`, carries a token and gives the recipient's details, which are not needed.
2. `retry`: one more request when the first fails to reach the site or hangs.

The request, the not-found answer (`单号不存在`), the "too busy" rate limit and the reply's checks
are the platform's, in [`itdida.ts`](../whwdt/itdida.ts). The lookup takes the system number,
the transfer number and the customer number alike, so the adapter accepts 6 to 40 letters and
digits.

## Notes

- On the line to Israel the rows are the Israeli partner's, from the order's data through import
  customs to the delivery. The partner's own wordings, and its first rows read as the order's
  data rather than an acceptance, are in [`statuses.json`](statuses.json).
- Rows placed `sms` are the text messages the partner sends the recipient. They name the
  recipient, the street address, the driver and the driver's phone, so the adapter drops them
  whole; the rows beside them carry the same milestones.
- Where the place goes, the partner writes its status names סגור ("closed") and חדש ("new"),
  which are not places and are dropped.
- Rows carry a wall clock with the zone field blank, so they keep `local_time`. They have no
  place, so a consumer dates them on the destination's clock: the catalog lists Israel among
  the countries U-Speed delivers in, which puts the Israeli partner's rows on Israel's clock,
  where their working hours fit. A row naming a place would take that place's clock, and a
  parcel to a country not listed takes Beijing's.
- The page also shows the system number, the customer number, the piece count and the
  recipient's city and postcode; none is kept.

## Limitations

- No delivery estimate or weight.
- The delivering partner is named only in its text messages, so the result names no delivery
  carrier.

## Numbers

The public sample is a transfer number in `RUN` and fourteen digits. One sample does not show
whether U-Speed or its Israeli partner issues that series, so no rule claims it and the adapter
answers explicit selection. The sample and its source are in [`numbers.json`](numbers.json).

## Links

The tracking page reads the number from `no` in its address and looks it up on load, so
`www.u-speedex.com/queryTracks?no={number}` opens one parcel.

## Testing

`U_SPEED_EXPRESS_TRACKING_NUMBER=… U_SPEED_EXPRESS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/u-speed-express`
