# 24plus

24plus shipments use enabled universal providers. There is no dedicated adapter.

24plus, from Hauneck in Hesse, is a cooperation of about 70 German general-cargo hauliers that carry pallets and
packages for each other. A partner haulier's consignment travels under the network's numbers and is tracked on this page, so members are not
separate carriers.

## Numbers

A colli number is `00` and the shipper's SSCC, which every GS1 shipper prints, so no rule names it. The tracker also
takes a partner number with that partner's reference.

## Why there is no adapter

The tracker is the same WebAccess application as CargoLine's and Schäflein's. With no public number to check the tracker's replies against, there is no adapter.

## Links

The tracker keeps the colli number in the path, as Schäflein's does, sometimes followed by the postcode, which the
link rule leaves out.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
