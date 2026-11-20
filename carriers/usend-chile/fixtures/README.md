# Fixtures

Pages of the guest tracker, `GET https://portal.usend.cl/rastrear-shipper/{guide}`, cut down to the
parts the parser reads.

- `delivered.html` is the reply for the public sample in `numbers.json`: the guide heading, the first
  piece with its own timeline, and the guide's history from its creation in Santiago to the delivery
  in Concepción, then the signed receipt's way back to Santiago. The signatory, their ID number, the
  courier and the staff member are masked; the photos, map and other pieces are left out.
- `not-found.html` is the page's answer for a guide it does not hold, with an invented guide.
