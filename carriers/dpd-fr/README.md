# DPD France

DPD France (formerly Exapaq), French last mile only. Tracked by parsing the
server-rendered recipient trace page. DPD Switzerland is a different protocol
in [`dpd`](../dpd/README.md).

## How it works

1. `trawl`: with a browser service (`FLARESOLVERR_URL`), its `scrape` API
   (`skipHttp`, `maxTier: 3`) loads `https://trace.dpd.fr/fr/trace/{number}`.
2. `direct`: without one, a GET of the same page with a browser-like
   `User-Agent`, 20 s timeout. A 403 with `cf-mitigated: challenge` or a "Just
   a moment" page is a Cloudflare challenge, which says "configure
   FLARESOLVERR_URL".
3. `retry`: that GET once more after a network failure or timeout. Until
   then `direct` gets at most half of the time left, so a GET that hangs
   leaves time for it.

Both tiers return HTML for the same parser. "Numéro de colis inconnu" (or "pas
en mesure de retrouver") with no parcel number on the page is not-found. Other
non-2xx statuses are indeterminate.

## Notes

- Detection: `250` + 12 digits selects DPD France. Other numbers starting with
  0 or 1 (12–15 digits) are suggestions; 14-digit numbers from the ex-Exapaq
  depots 10xx list DPD France first (DPD's published depot table and the
  published integration example), without selecting it.
- HTTP recognition never asks DPD France: Cloudflare challenges every plain GET
  of the trace page. The opt-in browser phase asks it through the browser
  service about the ex-Exapaq depots' fourteen digits and the sixteen-digit
  labels, not every run of digits its rules suggest, which are more often other
  carriers'. The trace page's dated rows for the requested number confirm it.
- Labels print the `250` number with a GS1 check digit as a sixteenth digit, and
  links often carry that form. When the check digit matches, detection lists DPD
  France first and the adapter looks the parcel up by its fifteen digits. The
  trace page shows those, or for some parcels the label form, which the adapter
  reads as the same number. Other sixteen-digit numbers are refused.
- DPD France also tracks eighteen-digit numbers beginning `1660`; universal
  providers read their history from it, and the adapter takes them. Detection
  does not offer DPD France for them, as other carriers' numbers share the length.
- With a browser service the plain GET is skipped: Cloudflare challenged every
  one, from a server and from a home connection alike, so it only added a
  failure before each browser lookup. Without one it is the only way to ask.
- One page can show an outbound parcel (`#infos1`, `tr.tabTraceColisAller`) and
  its return (`#infos2`, `tr.tabTraceColisRetour`). The requested number picks
  the leg; the other leg's rows are never read. A page without the requested
  number is a `SchemaError`, except when tracking another DPD unit's number for
  a parcel DPD France delivers: the page binds that number to its outbound tab
  (`#btnOngletAller[data-colis]`) and shows the parcel's `250` number, which the
  result names as `canonical_tracking_number`. Its rows are the same scans a
  universal provider relays for the other number. Browser recognition does not
  take such a page, since it claims the number itself.
- No status codes, only French prose, compared lowercase without accents or
  punctuation (DPD varies them between rows; a spacing accent such as
  "l´expéditeur" counts as an apostrophe). Earlier trace pages used shorter rows
  ("Colis livré", "Colis en livraison", "Colis en agence DPD France"); both
  styles are mapped.
- Rule order matters: returns, then incidents, then delivery. "votre colis sera
  retourné à l'expéditeur" would otherwise match a delivery rule, and "nous
  avons reçu une réclamation" would look like movement.
- "retard" maps to `failed_attempt`, as does a round that did not deliver ("Votre livraison n'a
  pas pu être réalisée ce jour, elle est reprogrammée au prochain jour ouvré"); "réclamation" and
  "enquête est ouverte" to `exception`.
- The notice that the recipient was told of the acceptance ("Le destinataire est informé par SMS
  de la prise en charge…") can come hours after a sort centre's scan, so it keeps the stage of the
  scan before it (`stage_source: 'none'`) and gives no result status; the acceptance's own row is
  `accepted`, and so is the driver's collection from the sender ("… pris en charge par notre
  livreur"), scanned beside it at the same instant. The round's own wording is "Le chauffeur a pris
  en charge…". The same-day delivery notice follows the round's scan and stays `out_for_delivery`.
  The notice of the delivery's current step ("… de l'étape actuelle de sa livraison") names no
  step, so it also keeps the stage of the scan before it, as does the notice asking the recipient
  to book the delivery again ("… de la nécessité de reprogrammer sa livraison"), which follows the
  round that did not deliver. The notice that the delivery is put off ("… du report de sa
  livraison") comes during the round, before the round's own failed attempt, so it keeps the stage of
  the scan before it too.
- A round that found the recipient absent and left the parcel at a Pickup point ("Le destinataire
  était absent lors du passage de notre livreur, nous avons déposé votre colis en point Pickup")
  reads `failed_attempt`; the Pickup point's own row follows. The notices that the parcel waits
  there ("… avisé par SMS de la disponibilité de son colis dans le relais Pickup", which DPD spells
  "disponibilté", and "… ne peut être avisé … car l'envoi de l'e-mail ou SMS a échoué") read
  `ready_for_pickup`.
- A staged newest row, a notice included, gives the result's `current_stage`: the result status
  says `out_for_delivery` for a parcel waiting at a Pickup point too.
- Unrecognized wording keeps the row with no `stage` and gives no `current_stage`; the result status comes
  from the newest recognized row. `statusMap` in [status.ts](status.ts) answers the app's
  review queue by the same wording.
- The fourth cell is the depot or sorting centre. The delivered row puts "Livré au
  destinataire" there, which is no place, so that row has no location. The app's
  scan-identity policy lets the row stored with it keep its identity, provided its
  instant, wording and known stage agree.
- The depot tab names the delivering depot ("Etablissement 067") and carries its map marker.
  Rows naming the same depot number ("Agence DPD de Strasbourg (67)") get that marker as
  their `point`: the depot is in Bischheim, 6 km from Strasbourg's centre. Other depots
  have no point, and the depot's street address is never read.
- Rows print naive `dd/MM/yyyy` + `HH:mm` in two cells, read in Europe/Paris.
  The planned delivery date is a calendar day, dropped once delivered or in
  exception. When the newest recognized row is the recipient's booking of a new
  day ("… a programmé une nouvelle livraison à son adresse pour le 09.03.2026"),
  that day is the expected delivery, and the row is `in_transit`. `delivered_at` is the newest delivery row of a delivered parcel.
- "Poids du colis" in the details block, when the page lists it, is the weight.

## Rejected approaches

- A JSON feed behind the page: there is none; the timeline exists only as
  markup.
- The myDPD app (`com.dpdgroup.chatbot.lemny.prod`): its guest lookup is the DPD
  Group service the [`dpd`](../dpd/README.md) adapter already reads,
  `POST https://www.dpdgroup.com/concept/webservice/v10/parcels/details/{number}`
  with a `businessUnit`. The app lists `DPD-FR` among its business units but
  sends French parcels to the website, and Cloudflare blocks the call for that
  unit. Without a postcode the service also returns less than the trace page.

## Limitations

- DPD France's site terms restrict unapproved automated access. Treat this as
  experimental; a contracted API is the long-term fix.
- Customer reference, delivery address and proof-of-delivery blocks are never
  read: the parser visits only timeline rows, labelled detail rows and the depot
  tab's first line and marker.

## Testing

`npm run test:carriers:live -- testing/browserProtectedCarriers.live.test.ts`
runs without a browser service, so it accepts either a clean not-found or the
challenge error.
