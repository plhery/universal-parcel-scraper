# FST Express

FST Express is a Sydney courier and freight forwarder. Parcels it brings into Australia clear
customs in Sydney and go on to Australia Post for the last mile. Tracked through the lookup its
tracker at `www.fstexpress.com.au/track_and_trace/` makes on FST's transport management system.

## How it works

1. `direct`: one `POST https://login.fstexpress.com.au/tms-saas-oms/expose/traceQueryResult`
   with the form `jobNo={number}&queryType=99`, as the tracker page sends it. It needs no cookie
   or token. The reply lists the jobs found under the number with their scans, newest first.
2. `retry`: one more try when the request fails to reach the service or hangs. The first try
   gets half of the budget.

- The tracker finds a job by FST's job number, by the Australia Post consignment number the job
  carries or by the sender's reference, so the adapter takes all of them. The job must name the
  number asked in one of those fields; a reply for another job, or several jobs under one
  reference, is inconclusive.
- Only `result_code` 1 with the sentence 未查询到该运单号的信息 ("no information was found for this
  waybill number") is not found. Any other code or message is inconclusive.
- The tracker answers every number with HTTP 200, so a redirect or a missing address is a moved
  service. The website runs a firewall that sets a cookie before it serves a page; the lookup
  host did not ask for one, and a firewall or bot check in place of the JSON is a challenge.
- A job without scans is listed without history. The page shows it as a number it could not find,
  but the tracker holds the job.

## Notes

- Each scan carries its wall clock and the same moment in epoch milliseconds. Their difference is
  the offset the tracker shows it at, so the scan is that instant at that offset. A scan without
  the instant, or whose two clocks do not differ by an offset a clock can have, keeps its wall
  clock.
- FST's own scans each have a code the map stages. FST relays Australia Post's scans under one
  code, `O1`, in Australia Post's wording, so the map stages those by their wording and the
  shared wording rules stage the ones it does not list.
- The page's legend calls `PU` a warehouse scan. An imported parcel reaches it after customs
  cleared it, so it stages as in transit rather than as the parcel's acceptance.
- The reply repeats some Australia Post scans; a repeated scan is kept once.
- When the job goes out through Australia Post's hub, or Australia Post's own scans name it, the
  consignment number the job carries is the delivery tracking number with Australia Post as the
  delivery carrier. A job without one hands over the article number of its one piece. Either
  number must be one Australia Post's rules take.
- The sender's and recipient's names, addresses and phones, the customer, the goods and the
  charges stay behind.
- Only FST's own job numbers have a detection rule. The consignment number has Australia Post's
  shape and stays with Australia Post's rule.

## Limitations

- A job of several pieces is tracked as one: the pieces' own scan lists and article numbers are
  not followed.
- The legend gives `OD` and `POK` one step, and `AR` one with delivery, so those codes are left to
  their wording until a reply shows them.
- No delivery estimate, weight, service or proof of delivery.

## Numbers

FST's job numbers are `SAUZ` and nine digits. The tracker page's script also carries a commented
example of `FST` and ten digits, which the tracker does not know. The samples and their sources
are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/fst-express`

The live test tracks the public samples in `numbers.json` that FST's tracker holds;
`FST_EXPRESS_TRACKING_NUMBER` tracks another number, and `FST_EXPRESS_UNKNOWN_NUMBER` checks the
not-found answer.
