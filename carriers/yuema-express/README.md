# Yuema Express

Yuema Express (玥玛速运), run by Yuema International Logistics (USA), is a forwarder in City of Industry,
California, shipping parcels from the United States to China, with branches in California and other US
cities and an overseas warehouse. It takes parcels in at its stores, flies them from Los Angeles, clears
them through Chinese customs and hands them to SF Express, which delivers them. The adapter reads the
lookup behind the tracking page on its site, yue777.com.

## How it works

1. `direct`: one `GET https://oa.yue777.com/Weixin/Hg/trace?bill={number}&callback=ehandle`, the JSONP
   lookup the page's script asks. It needs no cookie, session or CAPTCHA.
2. `retry`: the request once more when it fails to reach the lookup or hangs. The first try gets half
   of the budget, so the retry fits in the rest.

- The lookup takes several numbers separated by commas and answers an item for each, so a number is
  letters and digits only, and the item must echo the whole number asked.
- A number the tracker does not know gets HTTP 200 with an item of status 0, the topic `快递单号不存在!`
  and an empty list, read as not found. An item of status 0 with other words, a listed waybill
  without rows, a reply that is not JSON or a changed one is not a missing parcel; HTTP 401/403 or a bot
  check is a challenge.

## Notes

- Yuema's own rows, from the US store to Chinese customs, carry a code (LD, LJ, ZY, RK, PZ, CK, QF, DD,
  QG, CG) and the place in `state`, which becomes the location. The code stages the row, whatever store,
  warehouse or flight it names.
- The tracker merges SF Express's rows into the list, coded ZT, and SF's delivery, coded QS, with no
  place. The map reads ZT rows by their wording. SF's rows name the courier on the round and give their
  phone number: the adapter takes them out with the rules [UNICON Express USA's
  parser](../unicon-express-us/parser.ts) applies to the same wording, and drops a row left with nothing.
- The item names the courier and its number in `delivery_co` and `delivery_no`. They become
  `delivery_carrier` and `delivery_tracking_number` when the courier is 顺丰 and SF Express's rules take
  the number.
- Times are wall clocks with no zone. Every row is on China's clock, the US rows too: on it the flight's
  take-off and its landing in China are a day apart, where Los Angeles time for the take-off would make
  the crossing seven hours, and the Los Angeles office's rows fall in its working morning instead of
  between one and four at night. Each row keeps its wall clock in `local_time` and gains its instant on
  `Asia/Shanghai`, with `time_zone_basis` `carrier`.
- The rows misspell Los Angeles as `Los Angele`; the location reads Los Angeles.
- The item's destination district, piece count and order code stay behind.

## Limitations

- No delivery estimate, weight, service, recipient or proof of delivery.
- Yuema has only been seen handing parcels to SF Express. Another courier gets no `delivery_carrier`,
  and its rows are left to the shared wording rules or unstaged.
- The code list comes from one parcel; another code is staged by the shared wording rules or not at all.

## Numbers

Waybills seen are twelve digits, a shape many carriers print. No detection rule claims it and
recognition is off, so select Yuema Express explicitly.
The sample and its source are in [`numbers.json`](numbers.json).

## Links

Its tracker has no address for a single number, so no link names it.

## Testing

`YUEMA_EXPRESS_TRACKING_NUMBER=… YUEMA_EXPRESS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/yuema-express`
