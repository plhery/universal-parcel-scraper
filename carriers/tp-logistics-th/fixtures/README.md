# Fixtures

Whole replies of the tracker's two pages, kept as served: `search-*.html` from
`dtrack.php?id={number}&type=a1` and `history-*.html` from `tdetail.php?fn=a1&code={number}`.

- `search-delivered.html`, `history-delivered.html`: a public sample in `numbers.json`, delivered.
  The search page lists one line of goods with its quantity, destination district and summary
  status, beside the history button that names the number. The history page shows the sender
  and recipient, the goods, the movements from acceptance to delivery, newest first, with their
  province and branch, and the signature and photos filed under the number.
- `search-held.html`, `history-held.html`: a public sample in `numbers.json`, held at its
  destination branch and delivered two days later. The history page adds the hold reasons table,
  whose one row shares its minute with the hold, and lists two scans at the same minute.
- `search-not-found.html`, `history-not-found.html`: the replies for a made-up number. The search
  page has no table and carries the script that loads the "Not found this Code" box; the history
  page is the menu bar alone.

The tests build other replies from these by changing their text: clocks, codes in brackets,
goods, photos and statuses, a missing table, and pages for another number.
