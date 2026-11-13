# Pošte Srpske

Pošte Srpske parcels use enabled universal providers. There is no dedicated adapter.

Pošte Srpske, Preduzeće za poštanski saobraćaj Republike Srpske a.d. Banja Luka, is the public
postal operator of Republika Srpska in Bosnia and Herzegovina. It carries letters, parcels and
express items at home and abroad.

## Numbers

Its tracker follows domestic and international items by their 13-character UPU S10 numbers.
[BH Pošta](../bh-posta/README.md) and [Hrvatska pošta Mostar](../hp-mostar/README.md) also issue
S10 numbers ending in `BA`, so the suffix does not name the operator. Generic postal detection
handles S10 numbers, so no Pošte Srpske rule claims them.

## Why there is no adapter

The tracking page embeds a form from `postesrpske.com/track/` that posts the number. With no public
number to check its replies against, there is no adapter.

## Links

Its tracker takes numbers only through a form that posts them, so no address opens one item.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
