# La Poste / Colissimo

La Poste's unified tracking feed. It serves Colissimo, tracked mail and
[Delivengo](../delivengo/README.md), whose folder points `tracking.adapter` here.
The feed also answers Chronopost identifiers, but can omit international partner
scans and references without indicating incomplete history.
[Chronopost](../chronopost/README.md) therefore uses its own direct adapter.

Numeric tracked-mail identifiers reach the same feed without truncation or
conversion to a parcel number. Their detection rules live in `carrier.json`;
generic numeric lengths alone do not identify La Poste. A Colissimo number ends
in a GS1 key over the ten digits after its product code, and a tracked-mail
number's optional 15th character is DPD's ISO 7064 MOD 37,36 key. La Poste is
selected only when that key matches; otherwise it stays a suggestion.

Printed control suffixes are preserved in requests and checked against the
returned shipment identity. La Poste's
[Smart Data guide](https://www.espacetechniqueetqualite.laposte.fr/system/files/public/FICHE%20PRATIQUE_Utilisation%20des%20num%C3%A9ros%20de%20suivi%20SD_Lettre%20suivie.pdf)
describes their use; a suffix alone does not identify the carrier.

## How it works

1. `direct`: one keyless GET of
   `https://www.laposte.fr/ssu/sun/back/suivi-unifie/{number}?lang=fr`, the feed
   the public tracker calls, with the tracker page as `Referer`.
2. `retry`: the same request, up to three times, only after an HTTP 403 and only
   while the original 15-second deadline has time left. Each attempt gets the
   remaining time, so retries never extend the lookup.

The feed answers with an array; only the entry whose `shipment.idShip` equals
the requested number is read. `returnCode` 104 is the only positive not-found;
any other non-zero code is inconclusive, so the router can fall back to a
universal provider.

## Notes

- The 403 is usually La Poste's "Site indisponible - Incident en cours" page.
  Despite the wording it is a one-request edge hiccup, not maintenance: the next
  lookup succeeds, and it is most likely on the first request after a quiet
  period. Treating it as maintenance and skipping retries sent roughly ten
  times more lookups to the router, each benching the adapter for an hour. A real
  incident still fails all four attempts within seconds.
- Only 403 is retried. A 429 or a malformed payload won't be fixed by an
  instant repeat.
- The retries are three separate runner steps with the id `retry`, not a loop,
  so each rejection keeps its own diagnostics and the `attempts` label on
  `carrier_lookup_total` shows which retry served the lookup. `steps` lists
  tiers (`direct`, `retry`), not attempts.
- The deadline check lives in the `recovers` predicate. An exhausted lookup
  still throws the provider's `UpstreamHttpError` (403), not a
  `BudgetExceededError`.
- Status precedence: incident wording, then event `code`, then `group`, then
  wording. La Poste keeps a failed delivery inside its original group
  ("Incident : livraison impossible" arrives with code `DR1`, meaning
  registered).
- `DISTOU`/`MD1` also includes preparation at the distribution site. That precise label
  stays in transit until the parcel is on its delivery round.
- `AG1` means ready for pickup whatever its group or sentence. `DO1` is customs
  entry. Pickup and customs are set as `current_stage` because the status
  vocabulary has no value for them.
- Timestamps already carry their Paris offset and are passed through verbatim.
  `isoTime` only validates them; impossible dates are dropped.
- `contextData.partner` names the foreign carrier after export; it becomes
  `delivery_carrier` and `delivery_tracking_number`.

## Rejected approaches

- Scraping the public tracker page: it calls this keyless feed itself.
- Retrying a 403 with backoff: the hiccup is brief, so waiting only spends the
  user's deadline.
- Treating every non-zero `returnCode` as not-found: that reports parcels
  missing during a provider outage.

## Limitations

- `location` is the event's country; the feed has no city.
- The delivery estimate is dropped once the shipment is final.
- Recipient blocks and addresses on the shipment and its events are never read;
  events are built from an allowlist of wording, time, country and codes.

## Testing

`npm run test:carriers:live -- testing/frenchDirectCarriers.live.test.ts`
(no env vars) checks a wrong number gets a clean not-found or the recognized 403.
