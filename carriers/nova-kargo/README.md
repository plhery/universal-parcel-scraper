# Nova Kargo

Nova Kargo parcels use enabled universal providers. There is no dedicated adapter.

Nova Kargo is a domestic cargo company in Istanbul, with city courier, intercity and international
shipping. Its site is novakargo.com.

## Numbers

Public examples are twelve digits. Twelve bare digits fit many carriers' numbers, so there is no
rule.

## Why there is no adapter

Its tracker runs on Ajan.Net's Web Postman, the software of [KargoTurk's](../kargoturk/README.md)
tracker and of [Kargoist's](../kargoist/README.md) older one. Some carriers on that software ask for
a code sent by SMS before they show a parcel, and no found Nova Kargo page has been seen, so
KargoTurk's parser is not reused.

## Links

`webpostman.novakargo.com/tracking?har_kod=<number>` opens one parcel. Nova Kargo's own site has no
tracking form, so there is no search page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
