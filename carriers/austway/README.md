# Austway

Austway (澳华国际物流) ships parcels and freight from China to Australia by sea and air and
hands them to a local agent that delivers. The adapter reads the tracking page on Austway's
tracking host.

## How it works

1. `direct`: one `POST https://api.austway-cargo.cn/tracking.html` with the form field `orderNos`,
   as the page's own form sends it. It needs no cookie, session, CAPTCHA or browser.
2. `retry`: the request once more when it fails to reach the tracker or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- The server renders the rows; the page calls no JSON endpoint and does not read a number from
  its address, so the catalog has no link rule.
- The page gives a block per shipment it knows, titled with the waybill (运单号) and the delivery
  number (派送单号), and the tracker answers either; the adapter reads the block one of whose
  numbers is the whole number asked. A page where no number has rows shows `未查询到相关轨迹`,
  read as not found. A page without its form or result, or a row the parser cannot read, is a
  schema failure; HTTP 401/403 or a bot check is a challenge.

## Notes

- Rows come newest first, numbered, with a clock, a place and a wording. The local agent's
  rows can open with a status in one word and two hyphens, as `OutForDelivery--ATL`: the status
  becomes `provider_code` and the rest the wording, with the whole text in
  `original_description`.
- Times are wall clocks with no zone and stay `local_time`: the warehouse's and Shekou's on
  China's clock, Sydney's and the agent's on Australia's. A row at midnight is a day without a
  time and keeps only its date.
- The status map reads the wordings seen and, for a coded row, its status; `IN TRANSIT TO
  AGENT` reads the same whatever town follows.

## Numbers

The sample's delivery number is `AXP` and seven digits, beside a 16-character `LP` waybill. No
detection rule claims either for Austway, so select it explicitly. The sample and its source are
in [`numbers.json`](numbers.json).

## Limitations

- No delivery estimate, weight, service, recipient or proof of delivery.
- The page does not name the agent that delivers.

## Testing

`AUSTWAY_TRACKING_NUMBER=… AUSTWAY_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/austway`
