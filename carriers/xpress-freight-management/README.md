# XFM

XFM parcels use enabled universal providers. There is no dedicated adapter.

XFM, Xpress Freight Management Pty Ltd, is an Indigenous-owned Australian freight company. It
runs national road express, full trailer loads and warehousing from depots in Adelaide, Brisbane,
Cairns, Canberra, Darwin, Mackay, Melbourne, Perth, Rockhampton, Sydney and Townsville. Its site
is xfm.com.au.

## Numbers

The only public example is four letters and six digits, from an aggregator, so there is no
rule.

## Why there is no adapter

Its tracking page embeds a Transvirtual tracking widget, the system behind
[VT Freight Express](../vt-freight-express/README.md)'s tracker. The page's script reads
`consignmentNumber` from the address, fills the widget and submits it.

## Links

`xfm.com.au/xpress-track/?consignmentNumber=<number>` opens one consignment: the home page's
widget links there. A `/track/` address with the same parameter answers 404.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
