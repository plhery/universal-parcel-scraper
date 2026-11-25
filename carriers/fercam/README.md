# FERCAM

FERCAM parcels use enabled universal providers. There is no dedicated adapter.

FERCAM S.p.A. is a transport and logistics group based in Bolzano. Its tracking page sends
Italian shipments to the tracker of DACHSER & FERCAM Italia, its joint venture with Dachser
for groupage and home delivery in Italy.

## Numbers

DACHSER & FERCAM Italia's tracker asks for the letter O, the two-digit year and eight digits.
The layout is the tracker's own, but GLS Italy's `gls-it-digit-depot` takes any letter and ten
digits, and no public sample is known, so `fercam-1` only suggests FERCAM. FERCAM's FAQ gives
an older layout, a two-letter branch code, the year and six digits. TNT Italy's and GLS Italy's
rules take the same shape, so no rule claims it.

## Links

The public form opens `tracktrace.fercam.com/home/BaseTracking` in a new window,
with an encrypted `shipmentNumber` returned by its verification request. The library
does not construct that value.

## Why there is no adapter

The public form loads an image from `function/de/Captcha/Index` and submits its
answer to `function/en/Captcha/CheckSpeditionCaptcha`. An enlarged-image manual
reading passed in one of one attempts and opened the result for a synthetic
shipment, which showed “Tracking was not found.” This small manual sample does
not measure unattended recognition. A dated public positive and a repeatable
automatic image reader are still needed.

The myFERCAM portal needs a customer account.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
