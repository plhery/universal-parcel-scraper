# Azul Cargo Express

Reads Azul Cargo Express's public tracker on `azullogistica.com.br` through the optional TRAWL
browser service.

## Retrieval

Akamai refuses plain HTTP clients every page of the site, its home page included, so the
adapter has no direct step. The tracker's share link, `/Rastreio/Rastrear?awb=`, answers in
a browser like its form, which posts one `Awbs[]` entry and `BuscarRastreioPor: awb` to the
same path. The server renders one card per AWB. The card's id must be the whole requested AWB,
and an unknown AWB is named in the page's "Nenhum rastreio encontrado" notice. A page without
either is not a missing parcel.

The card keeps its full history in a hidden list, newest first, under the six phases of its
progress rail. Scans name their terminal by town, state and airport code, kept as the town and
state. Their clocks carry a day and a month without a year or a zone: the year is the latest
that puts the clock no later than the next day, and scans keep their wall clocks. The parcel's
stage is the card's last phase. The delivery scan names who took the parcel, kept as its
signatory; the phases' headings are not scans.

## Numbers

Azul tracks a shipment by its AWB: eight digits, or eleven. The form strips the airline's 577
prefix from an eleven-digit AWB, and so does the adapter. Eight and eleven digits are shared by
several carriers, so no rule claims them.

## Links

The share link carries the AWB as `awb`. The former tracker took it as `n` on `Rastreio.aspx`
with the AWB type.

## Limitations

Akamai can still refuse the browser; enabled universal providers remain the fallback. Order
numbers and the account's CPF/CNPJ search are not supported.

## Testing

Set `FLARESOLVERR_URL` and `AZUL_CARGO_TRACKING_NUMBER`, then run
`npm run test:carriers:live -- carriers/azul-cargo`. `AZUL_CARGO_UNKNOWN_NUMBER` also checks an
unknown AWB.
