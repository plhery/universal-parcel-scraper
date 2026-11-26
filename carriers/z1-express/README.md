# Z1 Express

Z1 Express (宙一物流) is a Shenzhen forwarder that flies parcels abroad and hands them to a
partner that delivers, GOFO in the United States on the sample. The adapter reads the tracking
page on Z1's site.

## How it works

1. `direct`: one `GET http://www.z1express.com/index.php?m=home&c=Search&a=track&trackNumber=<number>`,
   the page the site's search box opens. It needs no cookie, session, CAPTCHA or browser.
2. `retry`: the request once more when it fails to reach the tracker or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- The site answers plain HTTP only: its HTTPS port serves another host's expired certificate, so
  the catalog has no portal link. The search box posts to the same page, whose server renders
  the rows; the site calls no JSON endpoint.
- The page's search box holds the number asked, and the result table gives each number it knows
  beside its rows; the adapter reads the row of the whole number. A number the tracker does not
  know gets HTTP 200 with the single row `暂无数据，请稍后查询...`, read as not found. A page
  without its search box or result table, or a row the parser cannot read, is a schema failure;
  HTTP 401/403 or a bot check is a challenge.

## Notes

- Each row is a clock, then an English wording, the tracker's Chinese name for the step and a
  place, joined by hyphens. The step's name becomes `provider_code` and the text after the last
  hyphen the location; the rest is the wording. A row of another shape keeps its whole text.
- Rows the tracker copies from GOFO open with the station's town and state, which join the
  location, and end with the tracker's own Chinese label, which only `original_description` keeps.
- Rows keep the tracker's order, which is the order it wrote them, newest first, even where a
  clock is earlier than the row before it, as when import clearance opens before the flight
  leaves.
- Times are wall clocks with no zone and stay `local_time`. They read as each place's own clock:
  GOFO's rows put a round out for delivery in the morning only on the station's clock, and Z1's
  follow-on rows sit a fixed interval after the row they follow (eight hours, ninety minutes, ten
  minutes, to the second), so the eight hours between the data and the first scan is Z1's delay,
  not a UTC copy of a China clock. The catalog's zone is China's for rows that name no place.
- The status map reads each step's name, and the wording under the steps that hold more than
  one stage: 包裹清关, clearance whether it starts or ends, and 转运中(尾程单号轨迹内容), under
  which every GOFO row is copied.

## Numbers

Numbers are ZY and sixteen digits. No detection rule claims the shape, so select Z1 Express
explicitly. The sample and its source are in [`numbers.json`](numbers.json).

## Limitations

- No delivery estimate, weight, service, recipient or proof of delivery.
- The tracker copies the delivering partner's rows but not its name or its number, so there is
  no `delivery_carrier` or `delivery_tracking_number`.

## Testing

`Z1_EXPRESS_TRACKING_NUMBER=… Z1_EXPRESS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/z1-express`
