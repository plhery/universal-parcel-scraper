# Sengi Express fixtures

Every identifier, reference and timestamp is invented; `100C00000001F` has the shape of an SDA
waybill and was never issued. `sda-waybill.json` is a reply of the tracker's
`api-v2/tracking/web` in the shape of a live one: an object keyed by the number, its rows
oldest first, each with Sengi's English and Chinese wording, a wall clock and its UTC offset in
hours, the place `-` or the airport, the line's channel `PI` and no relabelled number. The
English wordings are Sengi's own; the event codes other than `10` and the Chinese wordings
other than the first row's are invented.
