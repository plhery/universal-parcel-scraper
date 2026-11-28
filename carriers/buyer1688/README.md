# 1688 International Logistics

1688 International Logistics (1688国际物流, buyer1688.ca), in Toronto, takes parcels in at its Toronto warehouse,
flies them to China, clears them through customs and hands them to JD Logistics. Tracked through the tracking
page on its own site.

## How it works

1. `direct`: one `POST https://www.buyer1688.ca/api86/buyer/check_post.htm` with the form `postid={number}`, as the
   page `www.buyer1688.ca/api86/waybill_query2.htm` sends it. It needs no cookie, token or account.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of the budget.

- `flag` 1 with no rows under the number asked is the platform's only answer for a number it holds nothing under,
  and the same answer it gives a parcel whose rows have gone. Only that is not found. Any other `flag` is
  inconclusive (the page shows nothing for it), a reply whose `packid` is not the number asked is refused, HTML is a
  browser check or a changed route, and any other status is a moved route or a request the site refuses.
- The site also has a lookup by the recipient's phone and name. The adapter never uses it.

## Notes

- `AcceptTime` is a wall clock with no zone, and the rows mix the warehouse's and China's. The rows at the
  Toronto warehouse and on the way out are on Toronto's clock, with `carrier` as the basis. From the first row
  whose text says the parcel has reached China, a port of entry or customs (到达国内, 口岸, 清关, 转关, 海关, 入境),
  the rows are on China's clock with `destination` as the basis. The platform lists the rows in the order they
  happened, and the adapter keeps that order across the two clocks. A clock that would date a row after the lookup
  keeps its wall clock alone.
- `exressno1` is the JD Logistics waybill, and the number asked again when there is none. It becomes the delivery
  tracking number, with JD Logistics as the delivery carrier, only when JD Logistics' rules take it.
- The page writes each row's text as HTML; the adapter reads it as text. The platform's own rows name no one. A row
  that names a courier or gives a phone would lose that clause and everything after it.
- `Action` is 1 on every row seen, so it is not kept as a code. `Location` was always empty.

## Limitations

- No public sample shows a parcel after the hand-off to JD Logistics, whose own tracker has those rows.
- No delivery estimate, weight, service name, location, sender or recipient.

## Numbers

The platform's parcel number on Kuaidi100's example is J, nine digits and CA. One sample does not establish the
shape, and the platform also runs other firms' trackers, so detection does not name 1688 International Logistics,
and the adapter answers explicit selection for any number of 6 to 30 letters and digits. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The tracking page does not read a number from its address, so the catalog gives its search page only.

## Testing

`npm run test:carriers:live -- carriers/buyer1688` tracks the public sample, or the number in
`BUYER1688_TRACKING_NUMBER`, and checks an invented number, or the one in `BUYER1688_UNKNOWN_NUMBER`, reads as not
found.
