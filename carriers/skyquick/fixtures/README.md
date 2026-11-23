# Fixtures

Each fixture follows SkyQuick's GETOnline page for one number, `go/plm-tracking?stid=skyquick&cn=`,
trimmed to the markup around the history and the script the server writes it into, block for
block as the page writes it.

`delivered.html` is the reply for the Trustpilot sample in [`numbers.json`](../numbers.json): a
parcel that left London and was delivered in Singapore after failed attempts, under the page's
three sections, with notices to the recipient, a return to the depot, the masked signatory, a
service type and the sender's reference. `not-found.html` is the reply for an invented number the
tracker holds nothing for.
