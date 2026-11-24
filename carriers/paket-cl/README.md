# Paket

Paket is a Chilean last-mile company delivering online shops' orders in the Santiago
Metropolitan, Valparaíso and O'Higgins regions. Shipments it books to the rest of Chile travel
with Starken under Starken's numbers, which Starken's own adapter tracks. Its site is
paketex.com; its tracking page is track.paket.cl.

## Numbers

Its tracker takes four to twelve digits, a shape many carriers share, so no rule names Paket and
a declared detection gap says why. The samples and their sources are in
[`numbers.json`](numbers.json).

## Retrieval

1. `direct`: one `GET https://paket-api-47404721744.southamerica-west1.run.app/envios/tracking.php?id={number}`,
   the request the tracking page's script makes for a number typed in, from the page's origin. It
   needs no session, token or cookie.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of it.

The page is a Flutter app; the endpoint, the handling of its replies and the alert headlines
come from its compiled script.

The tracker reads the number as a whole number: it finds a parcel asked with leading zeros and
repeats its number without them. The adapter keeps a reply only for the number asked, compared
that way.

A number the tracker holds nothing for gets HTTP 404 with "Envío no encontrado", read as not
found, as the page reads it. The message does not repeat the number; the stateless request for
the whole number binds it. Another message, a reply that is not a success, or one for another
number leaves the answer open. A browser check or a refusal is a challenge, a 429 a rate limit,
a 503 maintenance, a redirect or a 404 page a transport failure, and a page in place of the
JSON a changed reply.

There is no recognition: no detection rule offers Paket for a number, so preflight never asks
it.

## Privacy

The reply carries the recipient's masked name, masked phone and masked address, the commune,
the delivery note, a map point, photo links behind a phone check and the shop's name. The adapter
reads none of them. The page shows the unmasked details only after the recipient types their
phone number, which the adapter never does.

## Status

Each history row and the shipment carry a state code with a fixed title and sentence. The code
sets the stage; the row's sentence is its wording, else its title. A state the map does not know
goes to the shared wording rules. State 4 is titled "En tránsito" but says the parcel is on its
delivery round, as the page's rail does.

The newest staged row sets the parcel's stage. The page's headline takes over when the reply
marks the parcel as lost or its progress alert names a failed delivery, an order Paket never
received, or a return to the shop under way or completed; the headline is the status text. The
rail's step stands in when no row leads, and a shipment without rows stands on its state code,
its alert or its step.

## Clocks

Rows are wall clocks to the second with no zone. The three regions Paket delivers in keep
Santiago's clock, so each row keeps its wall clock in `local_time` and gets an instant in
`America/Santiago`, marked with the `carrier` zone basis.

## Limitations

- No location, delivery estimate, proof of delivery or delivery carrier: the reply has none, and
  it names no Starken number for shipments beyond Paket's regions.
- The map holds the states seen in replies; the alerts and the lost flag come from the page's
  script.

## Links

The tracking page opens numbers from its `id` parameter. Links in Paket's text messages put a
signature and a dot before the number; the library reads only the number after the dot and never
sends the signature.

## Testing

```sh
npm run test:carriers:live -- carriers/paket-cl
```

It reads the public sample from `numbers.json`; `PAKET_CL_TRACKING_NUMBER` and
`PAKET_CL_UNKNOWN_NUMBER` set outside the repository replace the sample and the synthetic unknown
number.
