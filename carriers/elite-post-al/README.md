# Elite Post

Elite Post parcels use enabled universal providers. There is no dedicated adapter.

Elite Post, Elite Post SHPK of Tirana, is an Albanian courier for same-day and express parcels
across Albania, with offices in its main cities. Its tracker is a white-label E-COURIER PRO
portal, as [Intex Courier](../intex-courier/README.md)'s is.

## Numbers

The portal finds a parcel by its track code and takes several codes at once. The field's example
is the platform's own, and no public page shows a whole code or its layout, so there is no rule.

## Why there is no adapter

The portal's form posts the codes with a session token and a Cloudflare Turnstile check, and the
form on the home page posts them too. With no public code to check its replies against, there is
no adapter.

## Links

Its pages take codes only through forms that post them, so no address opens one parcel. The
platform's GET route, which Intex Courier's site links to, is not one Elite Post publishes.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
