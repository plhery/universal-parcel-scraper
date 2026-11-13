# BH Pošta

BH Pošta parcels use enabled universal providers. There is no dedicated adapter.

BH Pošta, JP BH POŠTA d.o.o. Sarajevo, is a public postal operator in Bosnia and Herzegovina. It
carries letters, parcels, its BH PostExpress express items and EMS, at home and abroad, and
universal providers name it for the scans of international mail bound for the country.

## Numbers

Its tracking page follows items by their 13-character UPU S10 numbers.
[Hrvatska pošta Mostar](../hp-mostar/README.md) and [Pošte Srpske](../poste-srpske/README.md) also
issue S10 numbers ending in `BA`, so the suffix does not name the operator. Generic postal detection handles S10 numbers, so no BH Pošta
rule claims them.

## Why there is no adapter

The tracking page embeds a form from bhpwebout.posta.ba that posts the number back with the page's
ASP.NET view state. Universal providers relay its scans, so there is no adapter.

The providers relay its scans in Bosnian, each step marked for export ("Izvoz") or import ("Uvoz"). The
providers' shared reading stages them.

## Links

Its tracking page takes numbers only through a form that posts them, so no address opens one item.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
