# Fixtures

Whole replies of the tracker's lookup, `POST https://trackings.ge/en/track` with `track_num`,
kept as served.

- `ozon-canceled.json`: a public sample in `numbers.json`, an Ozon order Trackings.GE was to
  deliver. Two records name the number, with codes 666 and 901; the page's history shows one
  row, the cancellation, under the first record's date, and the status line says the sending
  was cancelled.
- `not-found.json`: the reply for a made-up number, `err_msg` `no_such_track`, which the page
  shows as "Sorry, your track … was not found".

The tests build other replies from the first by changing its records and rows.
