# PasarEX

PasarEX (Pasar Express) is a Bogotá courier running international express, air cargo and last-mile
delivery in Colombia, Chile, Panama and Barbados. It delivers Amazon parcels in Colombia. Its site
is pasarex.com.

## How it works

One `trawl` step: the tracker answers only after a reCAPTCHA checkbox, so the browser service
opens `https://tracking.pasarex.com/?awb=<number>`, ticks the checkbox and sends the form
([helper](../../trawl/pasarex-browser.mjs)). The checkbox has passed without a picture from a
home network. Elsewhere it asks for pictures, which the service's picture solver answers with a
local object detector; audio, which Google refuses from the service's address for hours at a
time, comes last. The form sends `GET /tracking` with `awb` and the
checkbox's `g-recaptcha-response` token, and the page comes back rendered on the server, in
English whatever language the browser asks for. The helper binds that one request to the whole
number and returns the number the page names and its rows. The token stays in the browser.

## Notes

- The page groups its rows under its own statuses (DELIVERED, IN CUSTOMS PROCESS, COMMENTS, …),
  not in time order. The adapter puts them newest first. A row's status is broader than its
  sentence, and the map reads the sentence. A round that ended without trying the door is a delay,
  not an attempt, and an arrangement with the recipient while the round is out moves nothing.
- A row has a day and a second without a zone, on the clock of the station that scanned it,
  in Colombia so far; the rows keep them as wall clocks.
- The tracker's only notice, `Guía no encontrada`, answers both a number it does not hold and a
  token it refuses. The helper sends the token seconds after the checkbox issues it, well within
  its two minutes, so the notice reads as not found.

## Limitations

Without the browser service there is no lookup. The page has no ETA, weight, sender or recipient.

## Numbers

Amazon numbers of AMZPSR and nine digits name PasarEX (`PSR`). They were looked up on its tracker,
as archived copies show, the tracker answers them, and no other carrier's rules take the shape,
so the rule is high: PasarEX has no recognition step that could confirm a lower rule.

## Links

Tracking links carry the number as `awb` on tracking.pasarex.com.
The tracker has no number field of its own, so the catalog names no search page.

## Testing

`npm run test:carriers:live -- carriers/pasarex`, with `FLARESOLVERR_URL`, `PASAREX_TRACKING_NUMBER`
and optionally `PASAREX_UNKNOWN_NUMBER` set outside the repository.
