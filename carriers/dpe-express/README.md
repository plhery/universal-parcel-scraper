# DPE Express

DPE Express parcels use enabled universal providers. There is no dedicated adapter.

DPE Express (递必易, Delivery Perfect Express) operates forwarding services from China
to Malaysia, Singapore and the Philippines, with warehousing and delivery in Malaysia.
It is separate from [DPEX](../dpex/README.md).

## Retrieval

The [guest tracker](https://www.dpe.net.my/tracking.php) submits `tracknumbers` in a
form. Its verification frame, `checkCode.php`, loads a session-bound six-digit PNG
from `Captcha.php` and posts `tncode` to `checkCodeAuth.php`. An accepted answer permits
the next tracking POST in the same session. The image uses PHP GD bitmap glyphs;
verification can be completed over HTTP without a browser.

The tracking reply is HTML encoded as GB18030. Missing or consumed verification
returns the form; a missing waybill has a result-table row beside the whole identifier.
No current public reference establishes a dated positive history for an adapter.

The site offers account and WeChat login flows. No official Android guest-tracking
package has been identified.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
