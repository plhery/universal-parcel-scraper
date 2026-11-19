# Paquetería Flecha Amarilla

Servicios de Paquetería y Envíos Flecha Amarilla S.A. de C.V., of León, Guanajuato, is the parcel
and courier arm of Grupo Flecha Amarilla's bus network. It carries parcels between its branches
across Mexico, for collection at a branch or delivery to the door. Its site is
paqueteria-flechaamarilla.com.mx.

## Numbers

A guía is a prefix and a number, printed with a space between them. Archived lookups on its former
tracker show P and C guías of six or seven digits and CB guías of six digits; those suggest
Paquetería Flecha Amarilla at low confidence, since other networks print short shapes like them.
Its tracker also lists I, PB and TP prefixes, which no public guía shows yet, so the rule leaves
them out. The adapter reads all six prefixes, written with the digits, a space or a hyphen.

## Retrieval

The tracking page's script posts a JSON list of guías, each with its prefix and digits apart, to
an AWS API Gateway service, with a fixed `Authorization` key from its public page. The adapter
sends the same request for one guía and requires the reply to name both parts of it; the prefix
comes padded with spaces. A request without the header answers HTTP 502.

An unknown guía is left out of the reply's `respuesta` list. The service answers the same empty
list for guías it knows when it is asked too often in a short time, so an empty list is
inconclusive with the reason `portal_not_found`, never not found.

Each scan names its state, the branch and two clocks: a .NET `/Date(…)/` instant with the branch's
offset, and the same wall clock as text. The adapter keeps the stated offset and requires both to
agree. The reply lists the oldest scan first. The delivery scan's `receptor` names who took the
parcel. The names of the sender and the addressee, the branches of origin and destination, and the
delivery note that repeats the receiver are left out.

## Stages

The states seen on public guías are staged. "En ocurre" is the destination branch holding the parcel
for collection. Any other state goes to the shared wording rules, and keeps its wording without a
stage when they do not read it.

## Links

The tracker reads the guía with a hyphen after the prefix, a form numbers are not stored in, so there
are no tracking links.

## Testing

`FLECHA_AMARILLA_TRACKING_NUMBER=… FLECHA_AMARILLA_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/flecha-amarilla`
