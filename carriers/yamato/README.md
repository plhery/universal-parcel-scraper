# Yamato Transport

Tracks domestic Japanese shipments through the public Japanese tracking form.
One HTTP form submission returns the shipment summary and scan list. The detail
heading must identify the requested number; an input echo is insufficient.
After return dispatch, subsequent scans belong to the return to the sender.
Detection offers a 12-digit number only when the first eleven digits, divided by
seven, leave the last digit. Japan Post and Sagawa print numbers with the same check
digit, so recognition asks Yamato only for parcels looked up from Japan. Its scan dates
usually lack a year, so a recognized parcel's activity keeps no instant.

The page answers 伝票番号未登録 or 伝票番号誤り for a number it does not hold: not found.
問い合わせ対象外 marks a number of a service the page does not track, such as
クロネコゆうメール. Its range is Yamato's, but that says nothing about a parcel, so the
lookup is inconclusive with the reason `unsupported_service`.

## Limitations

The portal usually omits the year from scan dates and delivery estimates. Those
scan dates remain in `provider_time_text`, with no invented timestamp or freshness
watermark. Dates that include a year use Japan's timezone. The summary still
reports the carrier's current state, and its product name (宅急便, ネコポス) becomes
`service_name`. International TA-Q-BIN uses a separate portal.

## Live test

Set `YAMATO_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/yamato/adapter.live.test.ts`.
