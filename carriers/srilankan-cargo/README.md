# SriLankan Cargo

SriLankan Cargo is the air freight service of SriLankan Airlines. Select SriLankan Cargo and enter a full `603` master air waybill or its eight-digit serial; the serial's last digit is its check digit.

## How it works

1. `direct`: the [public iCargo portal](https://srilankancargo.ibsplc.aero/icargoneoportal/app/main/#/app/tracking/awb) signs in as an anonymous guest through its GraphQL gateway, then asks for the waybill's summary and its activity with the portal's own named operations. The adapter sends the guest token as a bearer header.

## Notes

- The portal is the same iCargo product as China Airlines Cargo's, so both adapters share its client and reading in [icargoNeo.ts](../china-airlines-cargo/icargoNeo.ts). See the [China Airlines Cargo README](../china-airlines-cargo/README.md) for how it merges rows, books later legs and completes a delivery.
- The gateway asks for the waybill as eleven digits without a hyphen; a hyphenated waybill returns nothing.
- The cargo site at www.srilankancargo.com sits behind a bot check, but it only hands the number over to this portal, which asks for none.
- SriLankan's portal adds the consignee notice and the warehouse moves to China Airlines' activity codes.

## Limitations

- Flight numbers stay in the event wording. The pieces, weights, ULDs and routing are not returned as fields.
- The portal's shipper and consignee queries are not used.

## Testing

```sh
SRILANKAN_CARGO_TRACKING_NUMBER=… SRILANKAN_CARGO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/srilankan-cargo
```
