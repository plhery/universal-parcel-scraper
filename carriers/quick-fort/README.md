# Quick Fort

Quick Fort (速丰捷运国际物流有限公司) is a Hong Kong forwarder that carries express, air and road
freight between mainland China, Hong Kong and abroad. Its site is www.quick-fort.com.

## Retrieval

One `direct` GET asks the tracker's order page, `/search_kuai_di/search/orderid/<number>` on
www.quick-fort.com, as the site's search does; no key, cookie, session or browser is needed. It
names Chinese as its language: the site answers HTTP 500 to a language it cannot read, such as
Node's default `*`. The page lists the order's rows, newest first, each with a date and a
sentence, as a timeline (a table on the site's earlier design), and names the number in its
search field, which the adapter checks. A result laid out neither way is a failure, not an order
without rows.

A number the tracker does not hold gets the site's notice that no order was found
(`未查询到对应订单`), with HTTP 200; that notice is the only not-found. Another notice, a block
page and a changed page keep their failure kinds.

## Notes

- A history with more than 100 distinct scans returns the newest 100 and sets `history_truncated`.

- The rows relay the carrying network's scans in French or English. They have no codes, so the
  carrier's map reads each sentence, with any city, airport or country it names as an ellipsis. The shared classifier
  reads a sentence the map lacks, and an unread one leaves the row without a stage.
- Every row is on the tracker's own Hong Kong clock, wherever the scan was: 17TRACK dates the same
  rows on that clock, and a departure from Toronto then falls at night there.
- The rows of a German or Canadian leg are not read on the destination's clock either. In both
  histories the app has seen, each row comes a steady day or two after the one before, at any hour,
  as a timeline planned ahead would. On any clock some fall at night, such as a German delivery
  round starting at midnight on the tracker's clock.
- A row dated after the lookup is part of that plan, not a scan: the adapter holds it back until
  it is due, and a delivery dated ahead gives the expected day instead. The tracker has so far
  shown each row only once its time has come, so a row already due reads as a scan.
- Some rows write a place before, within or after the sentence, with a region or country code and
  a postcode, which can precede the town in the same part: English rows name it after "in" or ", serving". The adapter takes it out of the
  sentence and keeps its names and codes as the row's place, without the postcode. The English
  delivery row ends with the recipient's street and house number, which the adapter leaves out.

## Numbers

The parcels the app has seen carry QFT and twelve digits, and 17TRACK filed the first one's
whole history under Quick Fort. No public number has been found, so `quick-fort-1` has low confidence
and the corpus holds a synthetic one. The tracker takes any number of letters and digits, so the
adapter sends one of 6 to 40.

## Links

Tracking links carry the number in the path of the order page.

## Testing

`npm run test:carriers:live -- carriers/quick-fort`, with `QUICK_FORT_TRACKING_NUMBER` and
optionally `QUICK_FORT_UNKNOWN_NUMBER` set outside the repository.
