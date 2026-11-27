# ABX Express

ABX Express (ABX Express (M) Sdn. Bhd.), based in Subang Jaya, delivers parcels across Malaysia. Tracked
through the form on its site's tracking page.

## How it works

1. `direct`: a `GET https://www.abxexpress.com.my/tracking` for the form's anti-forgery token and the cookies the
   page sets (its anti-forgery cookie, and the load balancer's `acw_tc`), then a `POST /Home/Track` with
   `ConsignmentNo`, `Captcha=doneverify` and the token. No account or browser is needed.
2. `retry`: one more attempt in a new session when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- The page's slider check runs in the browser alone: when it passes, the page's script writes `doneverify` into
  the form's hidden `Captcha` field, and the server takes that value as it is.
- The result page names the number under "Shipment No:"; a page for another number is no answer. A number the
  tracker holds nothing under gets one row, "No record available", dated at the moment of the lookup: only that
  row is not found. HTTP 400 is a token the site did not take, and a 403 or a firewall's page is a challenge.
- The form takes up to 700 numbers separated by commas; the adapter sends one, and refuses a comma.

## Notes

- Each row gives the hub or state, the status and a date and clock (`dd/mm/yyyy HH:MM`) with no zone. ABX
  delivers in Malaysia alone, which keeps one zone, so each row is dated on Malaysia's clock with `carrier` as the
  basis. A zone that would date a row after the lookup leaves it its wall clock alone.
- The current status above the history gives the stage when the map knows its wording, else the scans do.
- A delivered parcel's page embeds its delivery photos as data URIs, four copies of each, a few megabytes in
  all, so the result page is read up to 16 MB. The photos are cut out before the page is read. Hidden inputs
  beside them hold the photo service's link and the sender's and recipient's phone numbers, which the page asks
  the last four digits of before it shows the photos; none of these is read.
- The delivery date above the history is a day alone; the delivery row has its clock, so the date is not read.

## Limitations

- No delivery estimate, weight, service name, sender or recipient.
- Only the wordings in `statuses.json` have been seen; others go through the shared wording rules.

## Numbers

The public samples are a China to Malaysia number and an open-source library's sample; neither prefix is shown to
be ABX's own, so detection names no carrier for them and the adapter answers explicit selection of any number of
8 to 30 letters and digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/abx-express` tracks the public sample, or the number in
`ABX_EXPRESS_TRACKING_NUMBER`, and checks an invented number, or the one in `ABX_EXPRESS_UNKNOWN_NUMBER`, reads as
not found.
