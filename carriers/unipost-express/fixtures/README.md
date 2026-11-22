# Fixtures

The result block of Unipost's tracking page, from its replies to the form's POST for waybills the
Internet Archive indexed as tracking links (see [`numbers.json`](../numbers.json)), with the site's
frame removed and the names of the sender, the recipient and whoever signed replaced by
`SENDER`, `RECIPIENT` and `SIGNER`:

- `delivered.html`: `1001419`, sent from Chișinău and delivered in St Petersburg, with two rows
  dated by their day alone.
- `dubai.html`: `1000814`, documents delivered in Dubai.
- `manifested.html`: `1001427`, documents within Chișinău, manifested and never scanned as delivered.
- `not-found.html`: the notice for the synthetic `999999990`.
