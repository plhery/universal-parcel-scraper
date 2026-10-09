# ZTO Express

Chinese domestic ZTO parcels use enabled universal providers. There is no dedicated adapter.

## How it works

The [official tracker](https://www.zto.com/check) posts waybills to
`hdgateway.zto.com/batchGetTrace`. Code `10201` asks the page to call `getVerifyType`,
complete its verification and repeat tracking with `x-captcha-id` and `x-captcha-code`.
The current widget is Dingxiang: a slider can escalate to an ordered-character challenge
before it issues a token. Its verification response and the repeated tracking response
must both succeed; a hidden slider or a loaded tracking page proves neither.

The bundled TRAWL image has no Dingxiang solver. Its GeeTest slider support does not cover
this widget or the character challenge. The [Correios OCR model](../correios-br/model/README.md)
recognizes lowercase Latin letters and digits as a string. Ordered Chinese-character verification
requires recognition of the requested glyphs, their image positions and the click order.
The OCR worker infrastructure can be reused with a suitable model; the Correios weights
do not cover this task. ZTO therefore remains on universal providers.

## Limitations

International ZTO services use separate portals. Domestic number shapes overlap other
carriers and do not establish ZTO ownership.

## Testing

Provider live-test inputs and commands are in the [provider READMEs](../../providers/README.md).
