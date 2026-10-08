# AliExpress / Cainiao

Cainiao is Alibaba's logistics network and carries the international leg of most AliExpress
orders. It rarely does the last mile: it hands the parcel to a local post or courier and
publishes that partner's number when it has one. The catalog recognizes a specific Cainiao
shipment-number family and suggests AliExpress for `CNG` and numeric `LP` references; other ambiguous formats
need the user to pick AliExpress or paste a `global.cainiao.com` link. Detection does not
select the last-mile carrier.

## How it works

1. `direct`: one keyless GET to `https://global.cainiao.com/global/detail.json?mailNos={number}&lang=en-US`,
   the JSON behind the consumer page. No session, cookie or token. 10 s timeout, no fallback tier.

HTTP recognition uses that same feed for ambiguous references. Matching shipment
activity confirms the Cainiao tracking leg; an empty internal pending module does not.

## Handoff

- The partner number comes from `copyRealMailNo`; only when that is missing or malformed is it
  extracted from the display prose in `realMailNo`. It is returned as `delivery_tracking_number`,
  with `destCountry` as `destination_country_name`.
- The host decides whether to hand off to the partner; see [`docs/ROUTING.md`](https://github.com/plhery/delivery-tracker/blob/main/docs/ROUTING.md).
  Checksum-valid `L…CH` numbers keep a Swiss Post confirmation probe unless Cainiao names another
  destination. The destination label only restricts that probe; it never picks the operator.

## Notes

- The endpoint can return several modules. Only the one whose `mailNo` equals the requested
  number is read; anything else is a `SchemaError`, because showing a stranger's parcel is worse
  than an error.
- The newest `latestTrace.actionCode` decides the status. The parcel-level `status` token
  (`DELIVERED`, `CLEAR_CUSTOMS`, `transport`…) has no stable vocabulary, so it is only a fallback
  when no action code exists. The action-code map comes from the MIT client
  [ha-cainiao](https://github.com/ha-parcel-integrations/ha-cainiao).
- `GTMS_STA_SIGNED` means a pickup station signed, not the recipient: it maps to
  `ready_for_pickup`, never `delivered`.
- Whether `out_for_delivery` means "on the van" or "at a pickup point" is decided once from the
  newest action code and applied to the whole history. Changing that would rewrite the stages of
  stored events on re-sync.
- An empty module is not-found only when `mailNoSource` is `EXTERNAL`. Otherwise the seller has
  not shipped yet and the parcel stays pending; a 404 would make the sync give up on an early parcel.
- Scan time is `timeStr` (local wall clock) plus `timeZone` (`GMT+2`, `GMT+8`…). `timeStr` alone
  would be read as UTC, the catalog timezone. The epoch `time` field is not the instant: it treats
  `timeStr` as Beijing time even for European scans.
- Cainiao's own notices (`LAST_MILE_ASN_NOTIFY`, "Carrier update") carry no `timeZone`. Their epoch
  keeps milliseconds that `timeStr` cannot hold, so the epoch is the recorded instant and `timeStr`
  its Beijing rendering: such a scan is read at `+08:00`. Any other scan without `timeZone` keeps its
  raw text, because a whole-second epoch may only be a reading of that text.
- Each event keeps its action code as `provider_code`. Unknown action codes leave the event without
  a stage; the sync classifies the wording and records it, with the code, for review. `statusMap`
  answers the review by code, and by wording for the four codes the queue held before events kept
  theirs.
- Cainiao has no place field. It writes a scan's town in brackets before the standard wording,
  `[Town] Out for delivery`, in every language. That town becomes the location and the wording keeps
  the rest. A bracket holding digits, capitals only, fewer than three letters or a carrier the module
  names stays in the text. No scan states its country, so the location is the town alone.
- The app scan-identity policy updates a scan stored with its town still in the wording, provided
  its instant and known stage agree.

## Limitations

- Undocumented, keyless endpoint. Failures surface as sync errors; nothing retries them.
- Scans without a bracketed town have no location. Customs, line-haul and pickup-point scans carry
  none.
- No pickup point: the scans do not name it, and the consumer page leaves self-pickup details to a
  signed-in AliExpress account.
- At most 20 scans are kept. The recipient block and proof-of-delivery links are never read.

## Testing

`npm run test:carriers:live -- carriers/aliexpress` needs no env vars. It checks
not-found with a synthetic number and handoff extraction on the public example in `numbers.json`.
`CAINIAO_TRACKING_NUMBER` adds a private shipment lookup through automatic detection.
