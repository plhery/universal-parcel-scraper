Replies of `GET https://logistics.konga.com/track?order_number=<number>`. `delivered.html` is the
reply to the public sample in [`numbers.json`](../numbers.json), without the Google tag and
analytics beacon Cloudflare injects into the page. `not-found.html` is the reply to a synthetic
number the tracker does not know. The tests derive their other pages from these.
