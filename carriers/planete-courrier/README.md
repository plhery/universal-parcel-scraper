# Planète Courrier

Tracks Planète Courrier, a courier based in Lachine, Montreal, that delivers in Quebec and hands
orders bound further to partners such as FedEx, through the order number on its own tracker.

## How it works

1. `direct`: the [tracker](https://www.planetecourrier.com/fr/suivi-courrier.html) answers a GET
   with the order number in `r`. The adapter asks the order's page (`&detail=true`) first. When
   that page has no dated step, it asks the list of orders the number names (`?r=` alone), whose
   notice says whether an order exists. No cookie, token or browser is needed.
2. `retry`: a request that fails to reach the tracker, or hangs, is sent once more.

The order's page lists every step, oldest first, with its day, its time and its wording. The
adapter keeps them newest first.

## Notes

- The order's page answers a number without an order with an empty page: one step, "Commande
  placée chez Planète Courrier", dated "Inconnu". Only the list says "Il n'y aucune commande de
  placée chez Planète Courrier avec ce numéro de suivi", which is not found.
- The list also gives that notice, after "Commande expirée", for older orders, while the order's
  page still shows their whole history. Reading the order's page first keeps those orders.
- The page's title names who delivers the order: "via Planète Courrier", or the partner and the
  partner's number, as "via Fedex" and FedEx's number. That partner becomes `delivery_carrier`
  with its number, and the partner's scans, which the page relays in French, stay in the history.
- A step at a depot ends with its town and province ("Arrivé au centre de tri - Lachine, QC"):
  the town moves to the scan's location.
- The page gives no zone: the scans keep their wall clock, which is Quebec's for Planète
  Courrier's own steps.
- Orders are numbered in sequence; nothing in a number points to Planète Courrier, so no
  detection rule claims it and preflight does not ask this adapter.

## Limitations

The recipient's address and the delivery signature sit behind a postcode check on the page and
are not read. A partner other than FedEx has not been seen, so it is not named as the delivery
carrier.

## Testing

`npm run test:carriers:live -- carriers/planete-courrier`
