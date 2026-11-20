# HMM

HMM, formerly Hyundai Merchant Marine, is South Korea's container line. Tracked through the
search on its public tracking page, for a bill of lading or a container.

## How it works

1. `browser`: with `TRACKING_CHROMIUM_PATH`, a fresh context opens
   `https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do`, types the number into
   the page's bill or container box and runs its search. The page posts
   `{"type": "bl" | "cntr", "listBl": [...], "listCntr": [...], "listBkg": [], "listPo": []}` to
   `selectTrackNTrace.do` and gets the results as HTML, which are read.

Akamai resets every plain HTTP request to `hmm21.com`, whatever headers it sends, so there is no
HTTP step. A browser passes without an account, cookie or CAPTCHA. Without a browser the adapter
answers a challenge.

## Notes

- Only the main frame's POST whose body names the whole number and its kind is read. The results
  must name the number asked, list the container whose moves they show, and give the bill in each
  container's row.
- HMM's answer for a number it does not hold names the kind of number it looked for; only the
  answer for the kind asked is not found.
- The history is the moves of the first container the results show. Each container's row gives
  its latest move: the bill is delivered once every container is returned empty, and until then
  the latest open stage leads.
- Moves keep their place's wall clock. A place ends with a US state's code or a country; HMM
  calls South Korea `KOREA`. The zone is the state's or the country's when it keeps one, and a
  Canadian province or a country with several zones keeps the wall clock alone.
- The wordings are staged in [statuses.json](statuses.json). The schedule of vessels and the
  estimated arrival, the ports summary, the vessels and the container sizes are not read.

## Limitations

- A container lookup returns the container's latest cycle, which may be a later shipment than the
  one asked about.
- Bookings have their bill's number, so a booking is looked up as its bill.
- A shipment listed without moves is no history.

## Numbers

Bills of lading are twelve characters: four letters for the office and mode, then letters and
digits. Import records put `HDMU`, HMM's carrier code, before them; the adapter drops it, since
the page's box takes twelve characters. Containers are ISO 6346 numbers, whose check digit is
checked before the lookup. Detection has no rule. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/hmm`, with `HMM_TRACKING_NUMBER`, `HMM_UNKNOWN_NUMBER`
and `TRACKING_CHROMIUM_PATH` set outside the repository.
