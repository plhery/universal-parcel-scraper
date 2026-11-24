# Prime Express

Prime Express (普瑞达国际物流, Prime Express Logistics) is a Chinese forwarder with parcel lines from
China to Europe and the United States, where local carriers such as J&T Express Germany deliver the
parcels. Its site is primexpslogistics.com; 17TRACK names it Prime. Tracked through its tenant of
the rtb56 tracking platform.

## How it works

1. `direct`: one `GET https://szprd.rtb56.com/webservice/Service.ashx` with `method=track` and
   the number, signed as the platform's pages sign it. It needs no cookie, token, account, CAPTCHA
   or browser. [`../yypost/rtb56.ts`](../yypost/rtb56.ts) builds the request and reads the reply.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half
   of the budget, so the retry fits in the rest.

- A number with no waybill is HTTP 200 with `"success":0` and "No query to track information",
  which is not found. Any other message is inconclusive, and a 404 or a redirect is a moved route.
- Only the entry whose `server_hawbcode` is the whole number asked is read; the merchant's
  reference, the proof of delivery and whoever signed never are.
- The tracking page, `track_query.aspx`, ignores a number in its address, so the catalog's link
  opens its empty search form.

## Notes

- Scans are wall clocks without an offset, so they keep `local_time`, the result keeps the
  tracker's order and the facade dates them by their places where it can. J&T Express Germany's rows,
  which the tracker copies in German once the parcel is handed to it, are an hour behind UTC: that
  gives the instant J&T Express Germany's own tracker gives the same scan, to the second, where the
  German place they name would put them two hours early. Their sites in `【】` are left out of the
  wording the map reads.
- Scans carry no code. [`statuses.json`](statuses.json) maps the wordings seen live; others go
  through the shared wording rules. The delivering network's notice comes in its own language.
- `channel_hawbcode` is the delivering network's number, kept as the onward number. Its carrier is
  named when that carrier's own rules claim the number whole.

## Limitations

- No delivery estimate, weight or service name.

## Testing

Set `PRD_TRACKING_NUMBER`, and optionally `PRD_UNKNOWN_NUMBER`, outside the repository and run
`npm run test:carriers:live -- carriers/prd`.
