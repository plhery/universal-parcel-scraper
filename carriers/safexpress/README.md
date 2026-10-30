# Safexpress

Safexpress parcels use enabled universal providers. There is no dedicated adapter.

Safexpress is an Indian express and supply-chain company carrying parcels and part loads by road and air across
India. Its site is safexpress.com.

## Numbers

Its waybills are twelve digits starting `1000`, as complaints and a review show; older waybills are eight digits.
Twelve-digit numbers of other carriers start with `1000` too, PostaPlus's and Trackon's among them, so there is
no rule.

## Why there is no adapter

Its tracker reads an open JSON API on dgapi.safexpress.com without a login or CAPTCHA. A GET to
`/sfxweb/waybillinvoicetracking/v1/getpropeliauth2token` returns a short-lived anonymous token; a POST to
`/sfxweb/waybillinvoicetracking/v1/trackingbytype` sends it in a `token` header, with a JSON body naming the
number in `docNo` and its type in `docType` (`WB` for a waybill; e-way bills and invoices also work). It
answers waybills old and new with their scans, and an unknown number with HTTP 200 and empty status and detail
lists. No adapter has been written for it yet.

## Links

The home page takes a waybill only in an encrypted parameter, so no link names it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
