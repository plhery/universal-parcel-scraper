# Ozon Express

Ozon Express is a Moroccan courier for online sellers. It is unrelated to Russia's
[Ozon](../ozon-logistics/README.md).

## Numbers

Its site's example is three letters, nine digits and two letters; the public sample is longer, and
sellers may choose their own codes through Ozon's API. Nothing in a code points to Ozon, so there is
no rule and preflight never asks it.

## Retrieval

The tracking box on ozonexpress.ma posts the number as a multipart form field `tracking-number` to
`api.ozonexpress.ma/customers/tracking-new`, with no session, key or CAPTCHA. The reply is an HTML
card, though it is labelled JSON: a header with the number, the time of the last update and the
current status, over a timeline of the parcel's steps, oldest first, each with its French status and
its date and time.

- The card must name the number asked. The tracker ignores case and echoes the number as sent.
- A step's time is Morocco's wall clock without an offset, and is kept as `local_time`.
- The timeline's markers are not read: they do not follow the steps. The payment state in the
  card's comments is not read either.
- A card without dated steps stands on the header's status when it has one; otherwise it is a
  parcel listed without history.
- Only the short card saying that the number does not exist is not found. A block page is a
  challenge, and any other page is a changed reply.

## Links

`ozonexpress.ma/tracking-colis/<number>` opens one parcel, and the library reads the number from
that address. The search page is the tracking box on the home page.

## Testing

`npm run test:carriers:live -- carriers/ozon-express-ma`

The live test tracks the sample in `numbers.json` and checks the not-found answer;
`OZON_EXPRESS_MA_TRACKING_NUMBER` tracks another number, and `OZON_EXPRESS_MA_UNKNOWN_NUMBER`
another unknown one.
