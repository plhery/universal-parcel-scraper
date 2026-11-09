# SPX Express Brazil

SPX Express Brazil is Shopee's delivery network in Brazil. It collects from sellers in Brazil,
carries Shopee's parcels from overseas sellers through its own warehouses abroad and Brazilian
customs, and delivers to the door.
Tracked through the lookup its tracker makes. `spx-ph` covers the Philippine network, whose
numbers carry a PH prefix.

A marketplace label of 28 characters is a shipment number followed by `SPXLM` and eight
digits. The orders answer the whole label and name the shipment number in it, which they do
not hold alone; the fleet feed holds the shipment number only. Both answers are bound to the
label's first fifteen characters.

## How it works

1. `direct`: one `GET https://spx.com.br/shipment/order/open/order/get_order_info` with
   `spx_tn={number}&language_code=pt`, as the tracker sends it for the number in its address.
   It needs no cookie, token, signature or browser. The JSON reply has the parcel's scans,
   newest first.

- An unknown number is HTTP 200 with a non-zero `retcode` whose message says the order index
  found none (`find [0]`). The page shows "Sua busca não gerou resultados" for that and for any
  other failure, so only that message is not found; other failures are inconclusive, and their
  error names the refusal's codes, failing step and count, never its text. A 404 or a
  redirect is a moved route, and a web page in place of the JSON is a gateway's check.
- "not found spx order" is a number the orders do not hold: a label SPX has not taken in yet,
  or a parcel only the fleet feed holds. It is inconclusive with `portal_not_found`, the
  carrier's own answer that it holds no history yet, not an outage.
- The tracking object must name the number asked.
2. `legacy`: an inconclusive order lookup, such as a number its orders do not hold ("not found
   spx order"), asks the fleet feed the tracker's scripts also read:
   `GET https://spx.com.br/api/v2/fleet_order/tracking/search` with
   `sls_tracking_number={number}|{seconds}{checksum}` and `x-language: br`. The checksum is the
   SHA-256 of the number, the time and the public checksum configuration SPX's Taiwanese and
   Philippine trackers share. The feed holds parcels the order system does not.

- The feed's `-1217` is a parcel without scans. It answers an unknown number with a server error
  and a rejected checksum with empty data, so these leave the order lookup's inconclusive answer;
  the reply must also name the number asked. The recipient and phone fields are not read.
- Recognition makes the same requests.

## Notes

- Each scan's `actual_time` is Unix seconds, so every scan is an exact instant. The page shows
  them in Brasília time, but the network also spans Brazil's other zones, so no wall clock is
  derived.
- `pt` is the page's own language code. Its lines name no one; the `pt-BR` lines put the
  recipient's name in brackets after a delivery, and the buyer's line adds who received the
  parcel. The adapter reads the `pt` line and still drops a clause naming who received it.
  Scans without a Portuguese line keep their English tracking name.
- The page leaves out the rows SPX flags hidden. Most are bookkeeping and stay out. A pickup
  that collected nothing, import clearance, the arrival at the last-mile hub and a return's way
  back are kept: no row the page shows stands for them, and a return's first shown row comes
  days after the parcel turned back.
- Scans at SPX's warehouses, forwarders, ports, hubs and sorting centres keep the place and
  coordinates the reply gives. Pickups, postings, deliveries and the return to the seller would
  name the seller's or the recipient's town, so they keep none: the town a posting's wording
  names after it ("Pedido postado Cidade Exemplo - SP") leaves the wording, and a row stored with
  it keeps its row. Facility addresses are not kept.
- Some facility wordings name their centre, origin or port after a colon ("Seu pedido saiu do
  centro logístico: Cidade Exemplo - SP"). The name leaves the wording, so it reads the same from
  town to town, and is the scan's place when the reply gives none: a departure from a logistics
  centre often names it only there. Rows stored with the name in their wording keep their row.
- The reply can list a customs check filed late among later scans; the history is ordered by
  the clocks.
- A fleet line opens with its hub in brackets. The hub leaves the wording and is the place of
  the hub taking the parcel in; a pickup or a delivery keeps none. A drop-off point's line opens
  with the point's name, often its keeper's, and a partner carrier's delivery with the partner's
  code; both are dropped, and neither keeps a place. Line-haul
  lines name internal transfer and trip ids, which are dropped. An unloading, in English in
  every language, reads "Unloading" or "Unloaded" at the hub it names. When that hub's own scan
  takes the parcel in within a day after it, the unloading is left out, since that scan stands
  for the arrival. A line haul leaving names its next hub, which is not its place. A delivery
  line drops who took the parcel.
- Tracking codes give the stages, and fleet statuses read like the order codes live parcels
  paired them with. Brazilian customs holding or inspecting a parcel is customs, its refusal to
  import is an exception, and every leg of a return is returned. A parcel lost (F969) or disposed
  of (F996, "Pedido descartado") is an exception: it reaches neither the buyer nor the seller.

## Limitations

- No delivery estimate, weight or delivery partner.
- The lookup also answers the numeric order reference its reply carries, which no rule claims.
- Neither lookup answers the 28-character labels made of such a number, `SPXLM` and eight digits.

## Numbers

Archived lookups on the tracker show BR followed by thirteen characters: twelve digits and a
final digit or letter, and the tracker still answers them. No other network issues that
layout, so the rule names SPX Express Brazil for it.

## Links

`spx.com.br/track?{number}`, with the number as the whole query string, is the address archived
lookups use, as on the Philippine tracker. After a search the tracker script moves to
`spx.com.br/detail/{number}`.

## Testing

`npm run test:carriers:live -- carriers/spx-br`, with `SPX_BR_TRACKING_NUMBER` and optionally
`SPX_BR_UNKNOWN_NUMBER` set outside the repository.
