# OOCL

OOCL, Orient Overseas Container Line, is the Hong Kong container line of the COSCO SHIPPING
group. Tracked through the public cargo tracking its site links to.

## How it works

`browser`: with `TRACKING_CHROMIUM_PATH`, a fresh context opens the site's link
`https://www.oocl.com/Pages/ExpressLink.aspx?eltype=ct&businessType=blNumber&businessNumber=…`.
The link redirects to the tracker at `pbcontroltower.digital.oocl.com` with a ticket for the
number in the page's address. The page asks `…/moc-cargo-tracking/captcha-config` whether to show
a CAPTCHA, then posts to `…/moc-cargo-tracking/summary` with the ticket in an `x-ct-ticket`
header. The adapter reads that summary: the shipments the number names, each container's
milestones and the route with its vessel calls.

Every reply is a JSON string of base64 that the page's script decrypts with AES-GCM under a key
it ships to every visitor, the nonce first. The adapter decrypts it the same way. No account,
cookie or CAPTCHA is needed, but Cloudflare stops plain requests to the site and the tracker,
and a browser passes its check.

## Notes

- The summary is taken only when its ticket is the one the site's link handed over for the
  number, and the reply must name the number and the lookup. A bill must name the number as
  its booking, its bill or a container's bill; a container lookup reads that container alone.
- Ten digits are looked up as a bill of lading and, when OOCL holds no bill, as a booking.
  An empty summary for each is not found.
- Each milestone carries its place's wall clock and the name of that clock, such as `EDT` or
  `ICT`. The adapter reads the name as the offset it stands for. `CST` is China's clock in
  China and in Taiwan, which OOCL files under China, and North America's central clock there.
  The place's country comes from its town, or from the route's facility of the same code or
  town. A clock it cannot name is read in the zone of a country that keeps one; otherwise the
  wall clock stays alone.
- A milestone's code is its name and its leg (`Outbound`, `Ocean`, `Inbound`), staged in
  [statuses.json](statuses.json). The empty container's return after the consignee unloaded
  it is a delivery.
- A departure from the first port of loading or a transshipment port without its actual time,
  and the arrival at the last port of discharge without its actual time, are planned steps.
- Vessels, voyages, weights, customs and the parties are not read.

## Limitations

- When the tracker asks for a CAPTCHA, the lookup is a challenge. OOCL's tracker has not asked
  for one.

## Numbers

OOCL's bills of lading are `OOLU`, its carrier code, and the booking's ten digits; the tracker
takes the digits. Containers are ISO 6346 numbers, whose check digit is checked before the
lookup. Detection has no rule. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/oocl`, with `OOCL_TRACKING_NUMBER`, `OOCL_UNKNOWN_NUMBER`
and `TRACKING_CHROMIUM_PATH` set outside the repository.
