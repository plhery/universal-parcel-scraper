# DPD Belarus

DPD's network in Belarus, part of the network DPD Russia runs in Russia, Belarus and
Kazakhstan with one tracker and one order numbering. It has no adapter of its own:
`tracking.adapter` is [`dpd-ru`](../dpd-ru/README.md), whose folder explains the request,
identity checks and status handling.

- Belarusian orders are BY and nine digits; no rule claims them.
- `mydpd.dpd.by/ols/trace2/standard.do2?orderNum={number}` opens the Belarusian tracking page,
  which searches on load; links to it read as DPD Belarus.
- The adapter asks the network's Kazakh portal first and the Belarusian one when that cannot
  be reached: both answer for Belarusian orders.
