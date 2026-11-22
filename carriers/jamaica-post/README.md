# Jamaica Post

Jamaica Post, the Postal Corporation of Jamaica, is Jamaica's national post.

## Numbers

Jamaica Post's items carry UPU S10 numbers ending `JM`, which generic postal detection keeps; no rule of its own
suggests Jamaica Post for them. The adapter takes S10 codes with a valid check digit. The Ja Mail tracker shows two
other layouts as examples, `ZL` and eight digits and `CSN` and four digits; no public item confirms them, so the
adapter does not take them.

## Retrieval

The Ja Mail tracker's form page, `track-status.php`, opens a PHP session and carries a CSRF token. The adapter posts
the number as `Consignment`, with the token and the session cookie, to `track-result.php`, as the form does. The
result page has a summary and the item's rows under a heading for each day, newest first. A code it holds nothing
for gets a notice that it was not found. The page must name the code asked.

A row names who handled the item, a staff role such as a distributor, the time, the next location and any status.
A row without a status records a hand-off to the next location, which the adapter writes under the page's heading
"Next Location" and reads as in transit. The handler and the comments are dropped, as are the summary's sender,
addressee and destination.

## Clocks

Rows carry a day and a time without a zone, read on Jamaica's clock, UTC-5 all year.

## Limitations

Only hand-off rows have been seen; statuses the page prints in its own column keep their wording without a stage.
The track and trace page sends international items to the UPU's Global Track and Trace, which this adapter does not
read.

## Links

The tracker takes the number in a posted form, so no address opens one item.

## Testing

```sh
JAMAICA_POST_TRACKING_NUMBER=<public sample> JAMAICA_POST_UNKNOWN_NUMBER=RR999999995JM \
  npm run test:carriers:live -- carriers/jamaica-post
```
