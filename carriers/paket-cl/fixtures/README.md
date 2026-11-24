# Fixtures

Replies of Paket's tracker, `paket-api-47404721744.southamerica-west1.run.app/envios/tracking.php`, asked with the
number alone, as the tracking page asks for a number typed in.

- `delivered.json`: the reply for the public sample in `numbers.json`, an order collected from a shop and delivered
  the same day. The recipient's masked name and phone, the commune and the shop's name are replaced with
  placeholders; the reply masks the address itself.
- `not-found.json`: the reply, with HTTP 404, for a synthetic nine-digit number the tracker does not know.
