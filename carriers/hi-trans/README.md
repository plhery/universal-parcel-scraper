# Hi-Trans Express

Hi-Trans Express consignments use enabled universal providers. There is no dedicated adapter.

## Numbers

Hi-Trans Express asks for the consignment note number. Its Freight API documentation looks up
three letters and three digits and says the prefix selects the sender's charge account. Many
carriers print letters followed by a counter, so no rule claims the layout.

## Links

The home page's track form opens `online.hi-trans.com.au/Connotes/ShowConsignmentSummary.aspx`
with the number in `Number`.

## Why there is no adapter

The public consignment summary can answer with a Cloudflare managed challenge before any
result. A dedicated browser recovery flow is not implemented. The Freight API needs the
username and token Hi-Trans issues to a customer, so it cannot replace public guest tracking.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
