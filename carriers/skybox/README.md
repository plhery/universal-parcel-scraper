# SkyBox

SkyBox parcels use enabled universal providers. There is no dedicated adapter.

SkyBox is a Miami package-forwarding service, a SkyNet affiliate: customers get a US suite address, and SkyBox
flies their purchases to Latin America for delivery. Its site is skybox.net.

## Numbers

Its numbers are twelve digits; the public example starts `0051`. Twelve digits are shared by many carriers, so
there is no rule. SkyNet Worldwide's tracker does not know SkyBox numbers.

## Why there is no adapter

Its tracking page loads an open HTML fragment without a session or CAPTCHA, which shows the parcel's scans and
says when a number does not exist. The fragment also names the recipient. No adapter has been written for it yet.

## Links

The public tracking page opens numbers from its `tracking` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
