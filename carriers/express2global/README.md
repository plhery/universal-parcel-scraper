# E2G Express

E2G Express (E2G速递, hainaexpress.com) ships parcels from the United States to China from its warehouse in
New Hampshire, with stations in Los Angeles, Las Vegas, Salt Lake City, Denver and San Francisco. It flies them
to a port of clearance in China and hands them to SF Express or ZTO. Tracked through its tracking service.

## How it works

1. `direct`: one `POST http://www.hainaexpress.com/track/tracking` with the form `num={number}`, as the
   tracking page's script sends it. It needs no cookie, token or account. The site answers plain HTTP only: its
   HTTPS certificate is another host's.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of the budget.

- The reply is JSON whose `data` is itself a JSON string of rows. With `status` `y` and no rows it is the only
  not-found. Any other `status` carries the members' orders that match the text sent, so it is not read and the
  lookup is inconclusive.
- The adapter sends only `E2G` or two letters, nine digits and `US`, the waybill shapes the samples have: the
  service matches other text, such as a name or a phone, against the members' orders.
- The reply does not echo the number: the scans are those of the number in the request. Every row must carry one
  waybill id, and on the `NH…US` waybills that id is the number's digits. No redirect is followed.

## Notes

- The rows carry no zone. The site prints its server's time as 中国北京时间, UTC+8, and on that clock the rows
  of the port and customs in China fall in working hours there, so every row is on China's clock with `carrier`
  as the basis. A clock that would date a row after the lookup keeps its wall clock alone.
- The last row names the courier in China and its number between slashes, `…/顺丰速运/SF…` or `…/中通国际/…`.
  That becomes the delivery partner and tracking number when the courier's rules offer the number.
- The site offers shipping from the US to China only, so a found waybill has those countries.
- A part of a row between slashes that names a person or a phone is left out. The samples' rows have none.

## Limitations

- No delivery estimate, location, weight, service name, sender or recipient. The scans after the hand-off are
  the courier's.

## Numbers

`E2G`, nine digits and `US` is the older waybill on Kuaidi100's test number, which detection names with low
confidence. The newer waybill, two letters, nine digits and `US`, has the UPU S10 shape, so detection does not
name it. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker is plain HTTP only, so the catalog links no page of it, and the canary checks 17TRACK. A pasted link
to the tracker's `track?num=…` page is read for its number.

## Testing

`npm run test:carriers:live -- carriers/express2global` tracks the public sample, or the number in
`EXPRESS2GLOBAL_TRACKING_NUMBER`, and checks an invented waybill, or the one in `EXPRESS2GLOBAL_UNKNOWN_NUMBER`,
reads as not found.
