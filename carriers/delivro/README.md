# Délivro

Délivro is a Quebec City courier delivering parcels across Quebec. Its site is delivro.com. Its
tracker runs on Dispatch Science, a dispatch platform that gives each courier account its own
host; Délivro's is `delivro.dsapp.io`.

## Numbers

Délivro's order ids are DEL and seven digits, a shape inside Australia Post's ten-character
consignment numbers, so no rule names Délivro and a declared gap says why. The adapter takes 6
to 40 letters and digits with at least one digit, in capitals. The samples and their sources are
in [`numbers.json`](numbers.json).

## Retrieval

1. `direct`: one `GET https://delivro.dsapp.io/api/v1/orders/tracking/{number}`, the request the
   tracking page's script makes. It needs no session, token or cookie. The adapter sends the
   page's `Accept` and JSON content type, and `Accept-Language: en`.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more within the budget.
   The first try gets half of it.

The tracker words the checkpoints in the language asked, English for `en` and French for `fr`.
The adapter asks in English; the map stages both.

The reply repeats the order id, in capitals whatever case was asked, and the adapter keeps it
only for that id. It gives the order's status code, the drop-off window or an ETA, the delivery's
instant, and the checkpoints newest first, each with an instant, a wording, the order's status
code when it was written, and an interruption flag.

An order id the tracker holds nothing for gets HTTP 404 with the framework's bare problem document,
read as not found: the reply does not repeat the id, the stateless request for it does. A 404
without that document, as a missing route gives, or a redirect is a moved tracker, another
problem document leaves the answer open, a refusal or a browser check is a challenge, a 503
maintenance, and a page in place of the JSON a changed reply.

There is no recognition: no detection rule offers Délivro for a number, so preflight never asks it.

## Status

Checkpoints are staged by their wording. A checkpoint's status code is the order's when it was
written, not the checkpoint's: a hold keeps "picked up". A wording the map does not know is a
problem when the tracker flags it as an interruption, and else goes to the shared wording rules.
The newest staged checkpoint sets the order's stage; the order's status code stands in when none
does, and alone for an order without checkpoints. Dispatch Science's "en route" code sits between
the pickup and the delivery on the page's rail and names no delivery round, so it is in transit.

## Clocks

Every instant states its offset, Eastern time for Délivro, and keeps it, to the second.

## Estimates and delivery

An order not yet delivered gets the page's estimate: its ETA when the reply has one, else the
drop-off window, from its start to its end. An estimate in another shape is named in
`unread_estimates`. A delivered or cancelled order gets none. The delivery's instant becomes
`delivered_at`.

## Privacy

The adapter never reads the pickup and drop-off towns, the drop-off and driver positions the page
can show on a map, the signature flags, the notes under a checkpoint, which are free text the
dispatcher writes, or the support line beside a hold. It never asks the signature route.

## Limitations

- Checkpoints carry no place, and the reply names no service, weight, sender or delivery partner.
- A hold's reason, in the checkpoint's note, is not read.
- The map holds the wordings seen with the sample, in English and French; others are staged by
  the shared rules where they can be.
- Délivro's site also links its own tracker at `operations.delivro.ca/suivi`, whose open
  `GET /api/suivi?numero={number}` answers with sort-centre and loading scans the Dispatch
  Science tracker leaves out, instants in UTC, the delivery window, the partner carrier and its
  number for a parcel a partner delivers, and beside them the signer's name and the delivery
  photos. The adapter does not read it.
- Other Dispatch Science tenants serve the same route on their own hosts; the parser could serve
  them, with their own maps and number shapes.

## Links

The tracking page takes the order id in its path.

## Testing

```sh
npm run test:carriers:live -- carriers/delivro
```

It reads the public sample from `numbers.json`; `DELIVRO_TRACKING_NUMBER` and
`DELIVRO_UNKNOWN_NUMBER` set outside the repository replace the sample and the synthetic unknown
order id.
