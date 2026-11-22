# Correo Paraguayo

Correo Paraguayo, the Dirección Nacional de Correos del Paraguay, is Paraguay's national post. Its site is
correoparaguayo.gov.py.

## Numbers

Its international items carry UPU S10 numbers ending `PY`, which generic postal detection keeps. No public page
shows one, so no rule of its own suggests Correo Paraguayo for them. The tracker
also holds mail other posts send to Paraguay, under their own S10 codes, so the adapter takes any S10 code with a
valid check digit. The layout of its domestic numbers is not public, so the adapter does not take them.

## Retrieval

The tracker page asks an open JSON endpoint, `/sen/?id_envio=<number>` on port 444, with no cookie, token or
captcha. It answers with the item's records, or with a message that it holds no data for the code, which is not
found. Each record must name the code asked.

A record is a summary, not a scan history: when the item entered the network, when it went on a dispatch sheet,
the office that holds it and the one in charge of it, its status and its weight. The adapter turns the entry and
the dispatch sheet into dated steps, and a later status into a step dated by the record's update. It drops the
addressee's name and the sheet's number.

## Clocks

The clocks name no zone. They are read on Paraguay's clock, UTC-3 all year.

## Limitations

An item from abroad shows only once Correo Paraguayo has it, without the origin post's scans. Only the
dispatch-sheet status is known; other statuses keep their wording without a stage.

## Links

Its tracker has no address for a single number, so no link names it.

## Testing

```sh
CORREO_PARAGUAYO_TRACKING_NUMBER=<public sample> CORREO_PARAGUAYO_UNKNOWN_NUMBER=RR999999995PY \
  npm run test:carriers:live -- carriers/correo-paraguayo
```
