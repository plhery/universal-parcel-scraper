# Major Express

Major Express parcels use enabled universal providers. There is no dedicated adapter.

Major Express (Мэйджор Экспресс) is a Moscow express and groupage carrier serving Russia.

## Numbers

Its waybill numbers (накладная) are ten digits, seen in an archived lookup on its tracker
and on the sample label in its labelling requirements. Ten-digit runs are printed by many
carriers, so no rule claims them.

## Retrieval

The tracking form sends the number as `tracking-number`, with `type=1` for a Major Express
waybill, to `major-express.ru/useful-services/track/`. Its submit handler opens that GET
directly and the server returns HTML. The site's SmartCaptcha script is shared with other
forms; its presence does not make verification part of the tracking submission.

The error notice combines an unregistered number with a shipment moved to the archive.
That reply cannot establish a definitive not-found result. No current public reference
establishes a dated positive history for the adapter. The [mobile site](https://m.major-express.ru/)
uses the same tracking form; no separate Android guest-tracking API is established.

Older lookups used `trace.aspx` with the number as `wbnumber`. Both URL formats are read as
links, but the old endpoint is not a current retrieval path.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
