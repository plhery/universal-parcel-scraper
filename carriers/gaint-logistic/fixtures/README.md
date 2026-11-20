# Fixtures

Replies of the tracker on `gaintlogistic.com`: `GET /api/captcha` for the security code, then
`POST /api/track` with the number and the code.

- `booked.json` is the reply for the public sample in `numbers.json`: an order on Gaint's own
  fleet, booked and not yet picked up.
- `captcha.json` is a security code of the observed shape with an invented code and token: the
  picture's five characters are text elements, here listed out of their left-to-right order.
- `not-found.json` and `code-mismatch.json` are the tracker's answers for a number it has no
  shipment under and for a code that does not match.
