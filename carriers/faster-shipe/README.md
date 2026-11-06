# Faster Shipe

Faster Shipe parcels use enabled universal providers. There is no dedicated adapter.

Faster Shipe (Fastershipe) is a domestic express courier in Riyadh with its own drivers, delivering
to Saudi cities. It is not Faster Express & Cargo, [faster-ae](../faster-ae/README.md) in the
catalog. Its site is fastershipe.com.

## Numbers

Its numbers are FS and nine digits, as its tracking page's script describes. Only one public example
is known, so there is no rule.

## Why there is no adapter

Its tracking page reads `id` from the address and asks
`GET fastershipe.com/api/track.php?id=<number>`, which answers JSON. No found reply has been seen.

## Links

`fastershipe.com/track.html?id=<number>` opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
