# INPOSDOM

The Instituto Postal Dominicano (INPOSDOM) is the national post of the Dominican Republic. Its
tracker, Inposoft's customer service page, follows items from abroad once they have entered the
country.

## Numbers

Its items carry UPU S10 numbers ending in DO, and items from abroad keep the sending post's
number. Generic postal detection handles both, so no carrier rule claims the layout: a rule
would name a post that recognition cannot ask. The adapter takes S10 codes with a valid check
digit. The samples and their sources are in [`numbers.json`](numbers.json).

## Retrieval

1. `direct`: one `POST https://inposdomtech.com/Inposoft/cliente/index.php` with `buscar` and
   `buscador=BUSCAR`, as the page's form posts it. It needs no session, token or cookie.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of it.

The page lists the records whose code holds the posted text, in any case, under a notice that
counts them. A record has the service, the code, the weight, the destination office, the
addressee, a monitor field, the entry date, the status and the destination office's address. It
holds one status, not a history. The adapter keeps the record whose code is the whole number
asked; another record alone, or several for it, is inconclusive. It reads the entry date as a
scan, `Entrada`, the day the item entered the country, and the status as the current status
without a date. The answer is marked `summary_only`, so a lookup asks the fallbacks for the
item's scans. The service is the service name; the destination office and its address become
the pickup point once the status says the item is ready for collection. The addressee, the
weight, which carries no unit, and the monitor field are left out.

A code it holds no record for gets a warning that the code is wrong or has not entered the
Dominican Republic, which does not repeat the code. It is read as not found because the reply
answers the request that posted the number and nothing else: the tracker keeps no session that
could pair it with another search, the page without a posted code carries no notice, and an
empty code gets a different one. The warning must stand alone, on the tracker's own page.

Cloudflare fronts the tracker. A browser check or a refusal is a challenge, a 503 without one
or a redirect is a transport failure, and the form page without an answer is a changed page.

There is no recognition: no detection rule offers INPOSDOM for a number, so preflight never asks
it.

## Clocks

The entry date is a day without a clock, kept as the scan's `local_time`; the status has none.

## Limitations

- Only items that have entered the Dominican Republic are listed; an item on its way there, or
  posted in the country for abroad, is not found. The listing covers a limited window: older
  public items answer not found too, so not found does not mean the item never reached the
  country.
- No scan history, scan places, delivery estimate or delivery time.
- Only a processing status at the head office has been seen; other statuses keep their wording,
  staged by the shared wording rules where they can be.

## Links

The tracker takes the number in a posted form, so no address opens one item.

## Testing

```sh
INPOSDOM_TRACKING_NUMBER=<public sample> INPOSDOM_UNKNOWN_NUMBER=<made-up S10 code> \
  npm run test:carriers:live -- carriers/inposdom
```
