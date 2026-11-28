# E24

E24 is the e-commerce and home delivery service of Metro Supply Chain, a Montreal logistics company,
delivering parcels and large items for Canadian retailers. Its site is metroscg.com; its parcels are
tracked on FarEye, a delivery management platform, at `tracking-ca.fareye.co`.

## Numbers

An E24 number is six and eight hexadecimal digits joined by a dash. The tracker finds a parcel only by
that exact form in capitals; the adapter takes the digits with or without the dash, in either case, and
writes them so. Other hexadecimal ids share the shape, so no rule names E24 and a declared gap says why.
The samples and their sources are in [`numbers.json`](numbers.json).

## Retrieval

1. `direct`: the two requests E24's public search page makes, without a session or cookie.
   - `GET https://tracking-ca.fareye.co/app/rest/get_universal_tracking_url?encodedString={key}&param1={number}&settingType=BASIC&language=en`
     finds the parcel. `{key}` is the `encodedString` of the public search page, the same for every
     visitor; FarEye refuses a search without one. The reply lists the parcel's tracking page in each
     language the tracker offers, or says `NO URL FOUND`.
   - `GET https://tracking-ca.fareye.co/app/rest/get_last_mile_and_status_details?url={token}&isReturn=false&isMultiShipment=false&universalTracking=true`
     reads the statuses of the first page, as the search page opens it. `{token}` is that page's query.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more within the budget.
   The first try gets half of it.

`NO URL FOUND` is the only not-found answer. Every status repeats the number, and the adapter keeps the
reply only for the number asked. A refusal or a browser check is a challenge, a 503 maintenance, an
HTTP 400 for the token leaves the answer open, a redirect or a missing route a moved tracker, and
anything else a changed reply.

There is no recognition: no detection rule offers E24 for a number, so preflight never asks it.

## Status

Statuses carry wording only. The tracking page words them in English, in French, or in both joined by a
slash, as the link the search gives first is set; each wording is staged whole, and a bilingual one the
map has not seen by its halves when they agree. The newest staged status sets the parcel's stage.

## Clocks

Every status gives its clock in UTC, which the page shows with " UTC", and E24's own clock. The adapter
keeps the UTC one, to the second.

## Privacy

The reply's feedback block holds the delivery photos. The adapter never reads it, nor the remarks or the
internal ids.

## Limitations

- FarEye drops a parcel some months after its delivery; the search then answers `NO URL FOUND`.
- Statuses carry no place, and the ETA the page may show is not read.
- The search key reaches other FarEye Canada merchants' parcels of the same shape; the statuses' wording
  is E24's.

## Links

The public search page takes the number in its query, so the portal link opens the parcel's page.
Retailers' notices link a parcel's own page by its token, which names no number.

## Testing

```sh
npm run test:carriers:live -- carriers/e24metro-ca
```

It reads the first public sample from `numbers.json`; `E24_TRACKING_NUMBER` and `E24_UNKNOWN_NUMBER`
set outside the repository replace the sample and the synthetic unknown number.
