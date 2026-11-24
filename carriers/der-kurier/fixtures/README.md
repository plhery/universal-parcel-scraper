`48800015025.html` is the reply of `GET https://leotrace.derkurier.de/paketstatus.aspx?Lang=DE&parcel=<number>`
to the first public sample in [`numbers.json`](../numbers.json), and `not-found.html` its reply to the invented
number 99999999999, which lists another parcel, whose number is replaced by a placeholder. The page's form state
and script keys are replaced by placeholders and its line ends made plain. `not-found.json` is the order service's
reply of `GET https://api.derkurier.de/rs/api/v1/order/find?parcel-no=99999999999&archive=true`. The tests derive
their other pages from these.
