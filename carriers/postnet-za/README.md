# PostNet

PostNet is a South African franchise network of counters for courier, print and business services. It sells its
own counter-to-counter waybills, which Aramex carries, and which [Courier IT](../courier-it/README.md) carried
before. It also resells DHL and Aramex, whose waybills are theirs.

## Numbers

Its waybills are PNA and ten digits or PPA and eleven, which `postnet-za-1` claims. Magyar Posta's domestic rule
also matches the PNA ones whose check digit happens to fit it. Older waybills, which Courier IT carried, are PN or
PP and seven digits; that shape is too generic to claim, so no rule suggests PostNet for them. The adapter takes
all three.

## Retrieval

The tracker page, `postnet.co.za/tracker`, opens a PHP session and carries a lookup token. For a waybill, the page
asks `/postnet-track/exit/` once for each network PostNet sends parcels with: DHL, Aramex, Courier IT, Sprint and
Coastal. A network that has the waybill answers with its events as JSON, each a day, a time, a place and a
description; one that does not answers with an empty body. The page shows the first answer with events.

The adapter makes the same lookups, with the token and the session cookie, one network at a time. Aramex comes
first and Courier IT second, as they carry PostNet's waybills, so a waybill usually takes two or three requests.
The first network with events answers, and the waybill is missing only when all five answer without it, as the
page reads it. A lookup without a live session is refused with HTTP 403, which says nothing about the waybill.

The answer does not repeat the waybill; the lookup names the whole of it.

## Events

An event of PostNet's own names the PostNet in brackets after the event, such as where the waybill was created or
where it waits for collection. That detail is kept. Courier IT's events name a detail after a dash, such as who
signed or which driver loaded the parcel, so only the event is kept, and Courier IT's status map reads it. Courier
IT's places are branch codes. Courier IT's adapter makes the same lookup for Courier IT's network alone.

## Clocks

Events carry a day and a time to the minute without a zone, read on South Africa's clock, UTC+2 all year.

## Limitations

The empty answer that tells a network has no waybill is the same as a network that failed to answer, which the
tracker does not tell apart. There is no delivery estimate, weight or service. Only Aramex's and Courier IT's
answers have been seen; the other networks' events are read the same way.

## Links

`postnet.co.za/tracker?pnpp=<number>` looks one number up, and the library reads the number from that address.

## Testing

```sh
POSTNET_ZA_TRACKING_NUMBER=<public sample> POSTNET_ZA_UNKNOWN_NUMBER=PPA99999999990 \
  npm run test:carriers:live -- carriers/postnet-za
```
