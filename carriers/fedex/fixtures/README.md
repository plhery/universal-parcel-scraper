# FedEx fixtures

`delivered.json` (international parcel, `DL`, signatory and shipper/recipient blocks), `in-transit.json` (`OD`, estimated delivery) and `held.json` (`HL`, held at a FedEx location with its `halCmpnyName` and `halAddress`) are `track/v2/shipments` replies built from the page bundle's package model. `999999999999`, `999999999998` and `999999999996` are synthetic, and so is the hold location; every private field is a `PRIVATE …` placeholder the offline test asserts never reaches a result.
