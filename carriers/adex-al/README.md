# ADEx

ADEx parcels use enabled universal providers. There is no dedicated adapter.

ADEx, Albanian Delivery Express sh.p.k. of Tirana, is an Albanian courier for letters, documents
and parcels: express and economy rounds within a city, and point-to-point and door-to-door
delivery between cities through its agencies.

## Numbers

Its tracking page finds a shipment by its POD code and takes several codes at once. No public
page shows a whole code or its layout, so there is no rule.

## Why there is no adapter

The tracking page's script sends the codes to the site's WordPress handler with a token from the
page, and shows each step of the history with its time, agency and description. With no public
code to check its replies against, there is no adapter.

## Leads

`POST /wp-admin/admin-ajax.php` with `action=adex_backend_call`, the codes as `pod_codes[]` and
the page's `security` token: `job=adex_verify_pod_ids` checks the codes, then
`job=adex_get_order_history` returns their histories.

## Links

Its tracker takes codes only through the page's script, so no address opens one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
