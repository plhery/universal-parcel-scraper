# ParcelABC

ParcelABC parcels use enabled universal providers. There is no dedicated adapter.

ParcelABC (Parcel ABC Limited) is a London booking site that sends parcels with partner couriers
under its own order code and shows each parcel's history on its tracking page. It has sites for
several European countries. Its site is parcelabc.com.

## Numbers

Customer reviews show order codes of two country codes, a hyphen and nine digits. Other networks
use four letters and nine digits too, including Sunyou and Z-Leading, so there is no rule.

## Why there is no adapter

The tracking page is an open server-rendered page that answers public order codes with their
history and sends an unknown code back to the home page. It needs the hyphen after the four
letters, which the library's number does not keep, so an adapter has to put it back.

## Links

A tracking link opens the order code from its path.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
