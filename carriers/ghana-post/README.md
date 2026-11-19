# Ghana Post

Ghana Post parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Ghana Post's letters, parcels and EMS items carry UPU S10 numbers ending in `GH`. Generic
postal detection handles these numbers, so no rule for Ghana Post claims them.

## Links

Ghana Post's local tracker at `epstools.ghanapost.com.gh/tracklocal.php` posts the number with
a reCAPTCHA through a full-page form POST to the same URL and has no address for one item.

## Why there is no adapter

The local tracker checks the solved Google reCAPTCHA checkbox answer before returning a
result. Missing or empty answers produce "Please complete the reCAPTCHA." The native form
POST navigates to an HTML document, including its missing-record notice. Browser capture
must observe that navigation and bind the submitted number before parsing the result.

The homepage opens this tracker. Its international tracker uses the UPU's Global Track &
Trace, already covered by the UPU provider. The Speedlink app's guest route serves Swoove
deliveries; coverage of Ghana Post postal items is unconfirmed. A dated positive and an
automated verification control are still missing, so there is no dedicated adapter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
