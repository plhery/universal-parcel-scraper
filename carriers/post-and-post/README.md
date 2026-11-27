# Post & Post

Post & Post items use enabled universal providers. There is no dedicated adapter.

Post & Post, in the province of Reggio Calabria, is a private post with agencies, for registered mail, judicial
notices and parcels. It is on the Italian Ministry of Enterprises' register of postal operators.

## Numbers

Codes that begin with a letter, other than those beginning ARG, are judicial notices; the tracker
searches the others as postal items. No public page shows a real number, so there is no rule.

## Why there is no adapter

The tracking page's two WordPress forms ask `/wp-admin/admin-post.php` with the barcode and a nonce
from the page, and the page loads reCAPTCHA v3. With no public number to check its replies against,
there is no adapter.

## Links

The tracker takes the number only from its form, so no address opens one item.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
