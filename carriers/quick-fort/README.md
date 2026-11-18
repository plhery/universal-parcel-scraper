# Quick Fort

Quick Fort (速丰捷运国际物流有限公司) is a Hong Kong forwarder that carries express, air and road
freight between mainland China, Hong Kong and abroad. Its site is www.quick-fort.com.

## Retrieval

One `direct` GET asks the tracker's order page, `/search_kuai_di/search/orderid/<number>` on
www.quick-fort.com, as the site's search does; no key, cookie, session or browser is needed. It
names Chinese as its language: the site answers HTTP 500 to a language it cannot read, such as
Node's default `*`. The page holds the order's rows, newest first, each with a date and a
sentence, and names the number only in its search field, which the adapter checks.

A number the tracker does not hold gets the site's notice that no order was found
(`未查询到对应订单`), with HTTP 200; that notice is the only not-found. Another notice, a block
page and a changed page keep their failure kinds.

## Notes

- A history with more than 100 distinct scans returns the newest 100 and sets `history_truncated`.

- The rows relay the carrying network's scans in French. They have no codes, so the carrier's map
  reads each sentence, with any city or airport it names as an ellipsis. The shared classifier
  reads a sentence the map lacks, and an unread one leaves the row without a stage.
- Every row is on the tracker's own Hong Kong clock, wherever the scan was: 17TRACK dates the same
  rows on that clock, and a departure from Toronto then falls at night there.
- Some rows write a place before or after the sentence, with a region or country code and a
  postcode. The adapter takes it out of the sentence and keeps its names and codes as the row's
  place, without the postcode.

## Numbers

The one parcel the app has seen carries QFT and twelve digits, and 17TRACK filed its whole
history under Quick Fort. No public number has been found, so `quick-fort-1` has low confidence
and the corpus holds a synthetic one. The tracker takes any number of letters and digits, so the
adapter sends one of 6 to 40.

## Links

Tracking links carry the number in the path of the order page.

## Testing

`npm run test:carriers:live -- carriers/quick-fort`, with `QUICK_FORT_TRACKING_NUMBER` and
optionally `QUICK_FORT_UNKNOWN_NUMBER` set outside the repository.
