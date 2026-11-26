# UNICON Express USA

UNICON Express USA (联合速递) forwards parcels from its warehouses in California to China: it
weighs them in, flies them to China, clears them through customs and hands them to a Chinese
courier, SF Express on the sample, which delivers them. The adapter reads the tracking page on
UNICON's site, lianhesudi.com, which the site names as its domain in place of lhexpressus.com.

## How it works

1. `direct`: one `GET http://www.lianhesudi.com/index.php?s=/Index/chaxun&sn=<number>`, the page
   the site's search box opens. It needs no cookie, session, CAPTCHA or browser.
2. `retry`: the request once more when it fails to reach the tracker or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- Both domains serve the same site over plain HTTP only; their HTTPS port does not answer, so the
  catalog has no portal link and the canary watches kuaidi100's UNICON page.
- The page's search box holds the number asked, which must be the whole number. A number the
  tracker does not know gets HTTP 200 with one row, `未找到 <number> 相关信息!`, read as not found
  when it names the number asked. A page without its result table or with a row the parser cannot
  read is a schema failure; HTTP 401/403 or a bot check is a challenge.

## Notes

- Rows come newest first, each a day, a minute and a wording, and keep that order. UNICON's own
  rows name no place. The courier's rows open with their city in `[]`, which becomes the location.
- The courier's rows name the courier on the round and give their phone number. The adapter takes
  out brackets that give a contact, a courier named after a colon or handed the round, the line
  asking to call the courier and any phone number, and keeps the rest of the wording. The status
  map reads that wording.
- The hand-off row, `包裹派送中，已转<courier>快递，快递单号为<number>`, gives
  `delivery_tracking_number`, with `delivery_carrier` set to `sf-express` when the courier is 顺丰速运
  and SF Express's rules offer the number.
- Times are wall clocks with no zone and stay `local_time`. The courier's rows are on China's
  clock; UNICON's own rows give no sign of theirs, so the catalog's zone is China's.

## Numbers

Waybills are LH and ten digits. No detection rule claims the shape, so select UNICON Express USA
explicitly. The sample and its source are in [`numbers.json`](numbers.json).

## Limitations

- No delivery estimate, weight, service, recipient or proof of delivery.
- UNICON has only been seen handing parcels to SF Express. Another courier's waybill becomes
  `delivery_tracking_number` without a `delivery_carrier`, and its rows may be left to the shared
  wording rules or unstaged.

## Testing

`UNICON_EXPRESS_US_TRACKING_NUMBER=… UNICON_EXPRESS_US_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/unicon-express-us`
