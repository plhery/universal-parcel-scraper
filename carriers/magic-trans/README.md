# Magic Trans

Magic Trans (Мейджик Транс) is a Moscow road carrier for consolidated freight with terminals in over
320 Russian cities. It also carries private shipments and delivers to marketplace warehouses. Its
operator is ООО «МТ ЛОГИСТИКА». Its site is magic-trans.ru.

## How it works

1. `trawl`: the browser service opens the tracker, `magic-trans.ru/otsledit-gruz/?id=<number>`, which
   fills its input from the address. The [helper](../../trawl/magic-trans-browser.mjs) drags the thumb
   of Yandex's SmartCaptcha slider and, once the check issues its token, clicks the page's button. The
   page posts the number with the token back to the same address as JSON, and the helper captures that
   lookup alone.

- The tracker answers with its whole page. The helper passes on the status, the dated rows, the
  transport and delivery kinds, and the same fields from a record the page prints in a hidden block.
- A token the tracker refuses leaves the result hidden, as it is before a lookup: a challenge. A number
  it does not know shows the result without a number in its heading and with an empty status: not found.
- The heading names the act number and the record names both forms, so the reply is bound to the number.
- Camoufox's humanized mouse sometimes hangs on a move. The helper then opens a fresh page in the same
  context and drags once more.

## Notes

- The handover, arrival and issue are days without a zone, in `local_time`. The handover takes the act's
  time when the act is dated that day.
- The arrival is read from the record's arrival date rather than the page's row, since the record keeps a
  planned arrival apart and the row's source is not known.
- The estimated issue day is the ETA until the cargo is issued.

## Limitations

- Three dated steps only: the tracker shows no scans between the terminals.
- No weight, places, volume, cargo name, packing, cost, terminals' addresses or opening hours.
- Only issued cargo has been seen live; the wording of other statuses is read by shared rules.

## Numbers

Its tracker takes a nine-digit act number, with leading zeros, or the act's track number: TR, the act
number and MT. Nine digits are a shape other carriers' rules take, and no public page shows a TR…MT
number, so there is no rule.

## Links

Tracking links carry the number as `id` on the `otsledit-gruz` page at magic-trans.ru.

## Testing

```sh
FLARESOLVERR_URL=http://127.0.0.1:8191 npx vitest run --config vitest.carriers-live.config.ts carriers/magic-trans/adapter.live.test.ts
```

The live test tracks a public sample in `numbers.json` through the browser service at `FLARESOLVERR_URL`;
`MAGIC_TRANS_TRACKING_NUMBER` tracks another shipment.
