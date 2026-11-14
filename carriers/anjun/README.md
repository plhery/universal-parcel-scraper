# Anjun Logistics

Anjun (安骏物流) is a Shenzhen cross-border logistics company with lines to Latin America,
Europe and North America. Its Brazilian arm, Anjun Express, carries marketplace orders such as
Shein's from its warehouse in China to the door, or hands them to Correios, and carries parcels
sent within Brazil. Tracked through the lookups its two tracking pages make.

## How it works

1. `direct`: one `GET https://trackserver.bailidaming.com/open/website/track?trackNo={number}`,
   as the tracker on `anjuntrack.com` sends it. The JSON reply lists the scans, newest first,
   and echoes the number in `extra.trackNo`.
2. `retry`: one more try when the first fails to reach the service or hangs. The first gets half
   of the budget.
3. `brazil`: when the tracker does not know the number, or has no scans for it, one
   `POST https://track.anjunexpress.com/track/open/website/query` with `{"trackNos": number}`, as
   the tracking page on `anjunexpress.com` sends it, with the same `token`. Anjun Express's
   service knows parcels sent within Brazil that the tracker never sees. It answers a number it
   has no scans for with an empty record, so the tracker's answer stands then.

- The request needs a `token` header: the time in Beijing as `yyyy-MM-dd HH:mm:ss`, encrypted
  with the RSA public key in the page's script, the same for every visitor. The adapter builds
  it for each request. No cookie, account or browser is needed.
- Without the header, or with a time more than a few minutes off, the service answers an empty
  HTTP 403, which the adapter reports as a refusal. A host whose clock drifts gets the same.
- The page first asks `/open/website/orderPackageType` for each number, which only echoes the
  numbers back. The adapter skips it.
- An unknown number is `{"code":500,"msg":"未找到单号"}` ("tracking number not found"). A number
  the tracker knows before its first scan gets `无此单号轨迹信息!` ("no tracking information for
  this number") instead, which is no history. Any other non-200 `code`, such as `轨迹接口异常`
  ("trace service error"), is inconclusive.
- A SafeLine firewall sits in front of the service. Its block page is reported as a challenge.
- The history must echo the number asked.
- Recognition makes the same requests.

## Notes

- Each scan's `date` is the scanning site's wall clock to the second, with no zone. One history
  goes from China's clocks to Brazil's, so the clocks stay `local_time`. Anjun Express writes the
  day first (`dd-MM-yyyy HH:mm:ss`), also on the site's clock, and Brazil has several zones.
- Anjun Express spells its codes apart (`statusCode`, as `transfer_in_storage`); the same map
  reads them. Its `collected` is the collection from the sender, the first scan of a parcel sent
  within Brazil. Its place is kept only as the town and state it gives (`Town / UF`); the note it
  shows under a collection, its sites, couriers, coordinates and photos are not read.
- The `stateCode` stages each scan. The tracker spells codes with stray spaces and mixed case,
  as `LM _has _collected`, so the map reads them in lower case without spaces. A code the map
  does not know falls to the shared wording rules. The codes the page's script sorts parcels by
  are mapped too, though no reply has shown them yet.
- Scan lines come in English for the legs in China and in Portuguese for those in Brazil. A
  failed delivery's reason (`extraData.problemType`) and the detail the page shows beside a line
  (`extraData.statusDetail`) follow the line. So does the note the page shows under it, without
  phone numbers or e-mail addresses. A delivery's note is dropped, as it can name who took the
  parcel.
- The recipient's street, number and district, which the page shows beside some lines, are not
  kept, nor are coordinates, facility addresses, the courier's name or the proof-of-delivery file.
- The page shows the destination's country code from `extra.countryCode` when the reply has one;
  the adapter keeps it as the destination country. Anjun Express carries parcels within Brazil,
  so its answers have Brazil as their destination, and a scan without a place takes a Brazilian clock.
- Returning to a sorting centre after failed deliveries is an exception: the parcel can still go
  out again.
- The reply names no destination carrier's number, so there is no hand-off.

## Limitations

- No expected delivery, weight or service.
- The tracker also answers Anjun parcels under the Correios number they carry in Brazil. The
  adapter takes only Anjun's own numbers; Correios numbers stay with Correios.

## Numbers

Anjun numbers are `AJ`, a six-digit date (`yymmdd`) and nine digits. Complaints and aggregator
samples give this shape and Anjun's tracker knows each of them, so `anjun-aj` claims it. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker on `anjuntrack.com` keeps the numbers it shows in `t` on `/trackQuery`, separated
by commas, so `anjuntrack.com/trackQuery?t={number}` opens one parcel. The Portuguese site
`pu.anjuntrack.com` uses the same address, and the home page's search form sends `orderNum` to
`/trajectory`. Anjun Express's own page, `anjunexpress.com/trackPackage`, takes `tracking`. A
Correios number in one of these links is detected on its own.

## Testing

`npm run test:carriers:live -- carriers/anjun`, with `ANJUN_TRACKING_NUMBER` and optionally
`ANJUN_EXPRESS_TRACKING_NUMBER`, a parcel sent within Brazil, and `ANJUN_UNKNOWN_NUMBER` set
outside the repository.
