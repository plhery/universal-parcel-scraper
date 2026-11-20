# Navex Delivery

Navex Delivery is a Tunisian courier. It collects parcels from online shops and delivers them
across Tunisia from its depots, with cash on delivery. Tracked through its public tracking page.

## How it works

1. `direct`: `GET https://app.navex.tn/track.php?track={number}`. No account, key, session or
   browser is needed.
2. `retry`: when Navex cannot be reached or hangs, the page is asked again once. The first try
   gets half of the budget.

- The answer is the tracking page with the number in its search field, then either a notice
  that Navex holds no parcel under it, or the parcel's card, headed with its number, and its
  history newest first. The answer is read only when the field and the card show the whole
  number asked, and the notice counts as not found only when the field shows it.
- A redirect is a changed page; a 404 or a 410 means the page moved; a 403 or a bot check is a
  challenge.
- Recognition makes the same request.

## Notes

- Event clocks are to the minute, without a zone, and read as Tunisian time, UTC+1 all year:
  Navex works only in Tunisia.
- A row's depot follows its wording after a dash and becomes the event's location.
- The tracker shows wordings without codes; the map follows the ones its tracker shows. A
  delivery wording not seen yet falls to the shared rules.
- The page lists some scans twice; a repeat of the same clock, wording and depot is kept once.
- The note under a row, an internal step name or a reason such as the recipient not answering,
  is not kept. The card's masked recipient name is not kept either; its merchant is the sender,
  and its destination town and governorate the receiver's address.

## Limitations

- No estimate, weight, service, proof of delivery or coordinates.

## Numbers

The tracker's own example number is twelve digits. No rule claims that layout, which many
carriers share, so recognition never asks Navex and a lookup reaches it when the carrier is
chosen. The adapter takes eight to twenty digits.

## Links

`app.navex.tn/track.php?track={number}` opens the tracking page with one number's answer.

## Testing

`npm run test:carriers:live -- carriers/navex`, with `NAVEX_TRACKING_NUMBER` and optionally
`NAVEX_UNKNOWN_NUMBER` set outside the repository.
