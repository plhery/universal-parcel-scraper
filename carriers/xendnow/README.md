# XendNow

XendNow (Xend Sdn Bhd) is a courier in Sungai Petani, Kedah, that delivers parcels to doors and to its
self-collection points. Its site is xendnow.my.

## How it works

1. `direct`: two `GET`s to the tracking API the tracking page asks from the browser,
   `https://integration.xendnow.my/delivery_history.svc/track_parcel_history/{number}` for the scans and
   `track_parcel_detail/{number}` for the box's card, with the Basic credential the page's script sends for
   every visitor. No cookie, session, CAPTCHA or browser.
2. `retry`: both once more when they fail to reach the API or hang. The first try gets half of the budget, so
   the retry fits in the rest.

- Both routes answer `[]` for a box they do not know: two empty lists are not found, and a card without scans
  is no history. Every row must name the box asked. A 400 or 401 means the page's credential changed and is a
  schema error; a redirect or a 404 is a moved route, a firewall page is a challenge and a 429 is a rate limit.

## Notes

- Each scan is a wall clock to the second with no zone, a numeric code and its wording. Malaysia has one zone,
  so consumers date the scans by the catalog's clock.
- `statuses.json` maps the codes seen. Another code is staged by the shared wording rules on its wording.
- A wording can continue on further lines with a collection point's opening hours; only its first line is
  kept.
- When DHL delivers the box, the card flags it and names DHL's number, reported as the hand-over. A number
  only one DHL network issues names that network; a shared shape names DHL Express, the one the catalog lists
  in Malaysia, when its rules take the number.
- The receiver's name, masked IC number, signature and drop-off proof, the courier's free-text remark, and
  the card's address and phone number are never read: remarks can name people.

## Limitations

- No places, instants, expected delivery, service or sender.
- No public box shows a DHL hand-over, so that path is built from the page's script alone.

## Numbers

The one public box id is `EX` and fourteen letters and digits. One sample cannot establish the layout, so no
detection rule offers XendNow.

## Links

The tracking page opens boxes from its `key` parameter.

## Testing

`npm run test:carriers:live -- carriers/xendnow`, with `XENDNOW_TRACKING_NUMBER` and optionally
`XENDNOW_UNKNOWN_NUMBER` set outside the repository.
