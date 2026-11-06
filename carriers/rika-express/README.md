# RIKA Express-Mail

RIKA Express-Mail parcels use enabled universal providers. There is no dedicated adapter.

RIKA Express-Mail (RIKA LLP) is a licensed express courier in Astana, Kazakhstan, with offices in
Astana and Almaty. It delivers across Kazakhstan and sends documents and parcels to the CIS and
worldwide. Its site is rika.kz.

## Numbers

Public examples are thirteen digits. Thirteen bare digits fit many carriers' numbers, so there is no
rule.

## Why there is no adapter

Its tracking page frames a form from MeaSoft's Courier Exe platform, which takes the number as
`orderno` by GET on RIKA's tenant page. No found reply has been seen.

## Links

`home.courierexe.ru/350/tracking?orderno=<number>` opens one parcel. Courier Exe hosts many
carriers, so only RIKA's tenant path is read. The tracking page on rika.kz takes no number.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
