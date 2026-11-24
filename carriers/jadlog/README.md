# Jadlog

Jadlog is a Brazilian parcel carrier in the Geopost group, which aggregators also list as DPD
Brazil. Tracked through Jadlog's own tracker, then the Geopost guest service that the
[myJadlog app](https://play.google.com/store/apps/details?id=com.dpdgroup.chatbot.jadlog.prod)
reads, with Jadlog's business unit.

## How it works

1. `direct`: a POST of the tracking form's `cte` to `https://www.jadlog.com.br/jadlog/rastreio`.
   The page asks for a reCAPTCHA v2 answer before it submits the form, but the server reads the
   number without one. The reply repeats the number asked and lists every row of the shipment's
   panel, oldest first, in Jadlog's Portuguese with a wall clock to the minute and no place.
2. `group`: when the tracker does not show the parcel, the guest API that the myDPD and myJadlog
   apps share, with `businessUnit=JADLOG` and no postcode. The Firebase installation, Remote
   Config and OAuth token come first, as for [DPD Switzerland](../dpd/README.md#how-it-works),
   and are cached per instance.

- The tracker redirects an unknown number to its error page. A reply that repeats another
  number, or has no result, is a schema error. Several panels, as for a sender's CNPJ, which the
  same field takes, are inconclusive, and a panel without rows has no history yet. Cloudflare's
  challenge page is a challenge.
- Any failure of the tracker goes on to Geopost. When Geopost fails too, the tracker's failure
  stands, unless the tracker did not know the number: then Geopost's answer does.
- Geopost's reply must name the requested parcel and list dated milestones. A details 404, or a
  400 typed `PARCEL_NOT_FOUND`, is not found; another 400 or a reply without milestones is
  inconclusive, and malformed milestones are a schema error. HTTP 429 is a rate limit.
- Recognition knows a number the tracker lists. Otherwise it asks Geopost, and knows a number
  only when the parcel's current country is Brazil. Another country is unknown, and a reply
  without one is inconclusive.
- A Geopost lookup is inconclusive when the reply places the parcel in another country under
  another business unit's code: the group-wide service answered for that unit's parcel.

## Notes

- The tracker shows only Jadlog's shipments. Geopost's guest service is group-wide, as
  [DPD Belgium's notes](../dpd-be/README.md#notes) describe, so a matching number does not make
  a parcel Jadlog's: recognition through it needs Brazil as the current country. DPD's units in
  Europe do not know a parcel placed in Brazil.
- The tracker's clocks are wall clocks in São Paulo, read in the catalog zone. Each Geopost
  milestone carries its own `-03:00` offset, which the scan keeps.
- The tracker's history is fuller and can be newer than Geopost's. Without a postcode Geopost
  gives each milestone once, with its newest date and no place, so its answer is marked
  `history_truncated` for enabled providers to complete. The tracker also lists numbers Geopost
  does not know.
- A tracker row and Geopost's copy of it fall in the same minute, Geopost's to the second under
  DPD's code. [identity.ts](identity.ts) lets a consumer keep one row for a scan read from
  either source with the same stage.
- The tracker words a delivery the same way when it shows it before another round to the
  address, in older histories. Such a row reads as transit.
- The reply names Jadlog's business unit as `060`. Recognition reads the current country, as
  DPD Netherlands' does, since one sample does not show which parcels carry that code.
- The catalog asks for no postcode: neither source needs one.
- [DPD's map](../dpd/status.ts) stages the guest codes, and the codes it leaves unmapped stay
  so. A scan without a code, from Jadlog's tracker or as providers relay it, reads Jadlog's
  Portuguese wording ([status.ts](status.ts)).

## Limitations

- Neither source gives places, a pickup point or an estimate.
- The tracker shows a parcel only after its reCAPTCHA, so results link to Jadlog's search page
  rather than to the parcel.
- A CNPJ with a single shipment reads as that shipment: its page does not tell a CNPJ from a `cte`.

## Numbers

Jadlog's API documentation names a fourteen-character tracking number, the `cte`, issued with
the consignment note, besides a fourteen-character shipment id and a shorter request code.
Archived lookups on Jadlog's tracking form show fourteen-digit `cte` values, which the guest
service takes as the parcel number. Fourteen digits are also DPD's parcel layout and are
printed by several other carriers, so Jadlog's rule is low and recognition asks Jadlog about
such a number beside the other carriers only for a lookup in Brazil, and for any other once they
have all missed the number. The same tracking field takes the sender's CNPJ.

## Links

Jadlog's tracking form sends the number as `cte` to `jadlog.com.br/jadlog/captcha`, and
archived lookups show that address with `?cte=`. The page asks for a CAPTCHA before it shows a
parcel, so the library reads the number from such an address but does not build one.

## Testing

```sh
JADLOG_TRACKING_NUMBER=... JADLOG_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/jadlog
```

Fixtures are synthetic ([fixtures/README.md](fixtures/README.md)).
