# Jadlog

Jadlog is a Brazilian parcel carrier in the Geopost group, which aggregators also list as DPD
Brazil. Tracked through the Geopost guest service that the
[myJadlog app](https://play.google.com/store/apps/details?id=com.dpdgroup.chatbot.jadlog.prod)
reads, with Jadlog's business unit.

## How it works

1. `direct`: the guest API that the myDPD and myJadlog apps share, with `businessUnit=JADLOG`
   and no postcode. The Firebase installation, Remote Config and OAuth token come first, as
   for [DPD Switzerland](../dpd/README.md#how-it-works), and are cached per instance.

- The reply must name the requested parcel and list dated milestones. A details 404, or a 400
  typed `PARCEL_NOT_FOUND`, is not found; another 400 or a reply without milestones is
  inconclusive, and malformed milestones are a schema error.
- Cloudflare's challenge page, whatever its HTTP status, is a challenge, and HTTP 429 a rate
  limit. No tier follows.
- Recognition makes the same request and knows a number only when the parcel's current country
  is Brazil. Another country is unknown, and a reply without one is inconclusive.
- A lookup is inconclusive when the reply places the parcel in another country under another
  business unit's code: the group-wide service answered for that unit's parcel.

## Notes

- The guest service is group-wide, as [DPD Belgium's notes](../dpd-be/README.md#notes)
  describe, so a matching number does not make a parcel Jadlog's: recognition needs Brazil as
  the current country. DPD's units in Europe do not know a parcel placed in Brazil.
- Each milestone carries Geopost's `-03:00` offset and the current status names
  `America/Sao_Paulo`. The scans keep the stated offset. A clock with no zone is read in
  São Paulo time.
- Without a postcode Geopost gives each milestone once, with its newest date and no place, so
  the answer is marked `history_truncated` for enabled providers to complete.
- The reply names Jadlog's business unit as `060`. Recognition reads the current country, as
  DPD Netherlands' does, since one sample does not show which parcels carry that code.
- The catalog asks for no postcode: the guest lookup answers without one.
- [DPD's map](../dpd/status.ts) stages the guest codes, and the codes it leaves unmapped stay
  so. A scan without a code, as providers relay Jadlog's own tracker, reads Jadlog's Portuguese
  wording ([status.ts](status.ts)).

## Limitations

- The reply has no places or pickup point.
- Jadlog's own tracker shows a parcel only after a CAPTCHA, so results link to Jadlog's search
  page rather than to the parcel.

## Numbers

Jadlog's API documentation names a fourteen-character tracking number, the `cte`, issued with
the consignment note, besides a fourteen-character shipment id and a shorter request code.
Archived lookups on Jadlog's tracking form show fourteen-digit `cte` values, which the guest
service takes as the parcel number. Fourteen digits are also DPD's parcel layout and are
printed by several other carriers, so Jadlog's rule is low and recognition asks Jadlog about
such a number only for a lookup in Brazil. The same tracking field takes the sender's CNPJ.

## Links

Jadlog's tracking form sends the number as `cte` to `jadlog.com.br/jadlog/captcha`, and
archived lookups show that address with `?cte=`. The page asks for a CAPTCHA before it shows a
parcel, so the library reads the number from such an address but does not build one.

The tracking widget belongs to `#formulario` and posts `cte` with its reCAPTCHA v2 answer
to `/jadlog/rastreio`. The guest API answers without it.

## Testing

```sh
JADLOG_TRACKING_NUMBER=... JADLOG_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/jadlog
```

Fixtures are synthetic ([fixtures/README.md](fixtures/README.md)).
