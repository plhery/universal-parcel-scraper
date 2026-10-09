# Poste Italiane

The Italian postal operator. Tracked through the keyless DoveQuando REST endpoint behind the
`poste.it/cerca` tracker. Dutch handoffs of Poste Italiane consignments stay with
[PostNL](../spring-gds/README.md). SDA parcel shapes are recognition candidates;
matching native Poste status or progress confirms them. Other postal shapes use the generic postal fallback.
The adapter refuses S10 numbers, so mail from abroad to Italy is not handed to Poste Italiane.

## How it works

1. `direct`: one `POST https://www.poste.it/online/dovequando/DQ-REST/ricercasemplice` with
   `{ codiceSpedizione, tipoRichiedente: "WEB", periodoRicerca: 1 }` and `poste.it`
   `Origin`/`Referer`. No cookies, token or account. The echoed `idTracciatura` must match.
   The envelope decides the outcome, not the HTTP status (unknown numbers answer 200):
   - `esitoRicerca` `1` or `2`: not-found.
   - No `esitoRicerca`, parcel type `P` and explicit empty `listaMovimenti`: an old expired parcel, also not-found.
     Unknown and expired look identical to an anonymous caller.
   - `esitoRicerca` `3` with no movements: the parcel exists but is unscanned, so
     `pending`/`registered`, not unknown.
   - HTTP 404/410 means the tracking endpoint is unavailable. Other non-200 replies remain upstream errors.
   - Missing or unusable history is a schema failure. Unrecognized empty envelopes remain inconclusive.

## Notes

- SDA delivery services use [Poste's shipment search](https://business.cert.poste.it/business/files/1476520760931/poste-delivery-business-express-standard-scheda-prodotto.pdf).
  Its [official request builder](https://www.poste.it/cerca-app/js/module/forms-ricerche-directive.js)
  submits the complete code. Detection and adapter eligibility share the catalog rules;
  neither a matching shape nor an expired reply confirms issuance.
- Envelope `stato` `5` forces `delivered` whatever the movement wording says: a delivered
  parcel sometimes carries a truncated last line. A parcel sent back ends with its delivery
  to the sender; that delivery carries the return flag (`flagRitorno`) and reads as
  `returned`. Without per-movement flags, the envelope flag and an earlier return scan
  decide.
- Stages come from Italian `statoLavorazione` wording. Both the typographic and the ASCII
  apostrophe are accepted (`e' stata consegnata` appears live). Unmapped wording gets no
  stage rather than a regex catch-all guess; the sync records it for review.
- Customs release wording maps to `in_transit`.
- `luogo` is dropped: nothing tells a depot from a recipient address, and guessing could leak
  the address. A post-office scan names its office, which becomes the event location; the
  office's address, postcode and hours are not kept.
- `dataPrevistaConsegna` is Italian prose ("Consegna prevista entro Venerdì 2 Gennaio 2026"),
  reduced to a calendar day and cleared once delivered. Unparsable text yields no estimate.
- `dataOra` is epoch milliseconds, so there is no zone to guess. A local helper renders it
  with milliseconds (`.000Z`) because those strings are persisted and `core/time`'s
  `epochMillisTime` would drop them.
- At most 20 events are returned, newest first.
- Sender, recipient, address, signature, weight, dimensions and pickup office are never read;
  a test asserts it.
- Not used: scraping `poste.it/cerca`. It is a JavaScript app and its HTML carries no history.

## Limitations

- Event locations only for post-office scans.
- Day-resolution estimate only.

## Testing

`npm run test:carriers:live -- carriers/poste-italiane`. The unknown-number
check needs no env vars; set `POSTE_ITALIANE_DELIVERED_TRACKING_NUMBER` to also check a real
delivered parcel.
