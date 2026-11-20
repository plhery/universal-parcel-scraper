# BEST Express Vietnam

BEST Express Vietnam parcels are read from the tracker on [best-inc.vn](https://www.best-inc.vn/track),
past BEST's picture verification.

BEST Express Vietnam is the Vietnamese parcel network of BEST Inc. `best-transport` is an
unrelated Scandinavian carrier.

## Numbers

Archived lookups on the tracker show fourteen-digit waybills and, once, TK followed by nine
digits. Fourteen digits are shared with DPD and other carriers, and a single TK lookup does not
establish a family, so no rule names BEST Express Vietnam.

## Links

`best-inc.vn/track?bills={number}` opens the tracker with the number filled in, the address
archived lookups use; the tracker script also reads `waybill`.

## Retrieval

The tracker posts the waybill to `www.best-inc.vn/express-cc/express/expresslistinfo` with a
verification from BEST's service at `captcha-sg.800best.com`, which knows the tracker by a key its
page gives every visitor. The service draws a round picture turned by a random angle and takes one
answer per picture: how far clockwise it is turned, within about seven degrees. It refuses an
answer sent within a couple of seconds of the picture, so the adapter waits three seconds. A
verification serves one lookup; a reused one gets `risk_001`.

The service draws its pictures from a few hundred photographs. `rotate-library.json` holds the
photographs whose upright the service has accepted, each as rings of grey levels around the
centre with the rings' mean colours. The [worker](rotate-worker.mjs) finds the photograph by its
colours and the turn by correlating its rings, and answers nothing when no photograph matches or
two that match disagree. The adapter then takes a new picture: it answers up to eight pictures
out of sixteen. To add photographs, label pictures of them with the clockwise turn that makes
each upright and run `node scripts/best-rotate-library.mjs <pictures-dir> <labels.json>`.

The reply lists the scans oldest first with their instants, after the order itself. A scan's
wording opens with its district and site, and a collection or a round names the courier with
their phone; the site becomes the place and the courier is left out. The tracker lists a
waybill it does not know with an empty history. A waybill in `notMatchCodeList` is shown only with
digits of the recipient's phone, which the adapter does not ask for.

BEST's other trackers share the service and the reply. `BestTracker` takes a country's tracker
address, verification key, language and clock; [BEST Express Thailand](../best-express-th/README.md)
uses it with English scans.

## Testing

```sh
npx vitest run --config vitest.carriers-live.config.ts carriers/best-express-vn/adapter.live.test.ts
```

The live test tracks a public sample in `numbers.json`; `BEST_EXPRESS_VN_TRACKING_NUMBER` tracks
another shipment.
