# JD Logistics

Each waybill is asked where its series is kept. Mainland series (`JD` followed by `0`, `JDJ`, `JDK`,
`JDV`, `JDVA`–`JDVC`, `JDX`, `JDAZ`) go to the public domestic tracker through TRAWL; the
international feed does not hold them. `JDW` and `JDAP` go to the international website's
anonymous feed. A JD series not seen yet asks the feed first, then the domestic tracker when the
feed holds nothing. Without TRAWL, and for HTTP recognition, every series asks the feed. HTTP
recognition reads the feed's empty answer as unknown, except for a series the domestic tracker
may hold, which it leaves to browser recognition. A series is a route, not evidence: the response must confirm the
whole identifier.

## How it works

One JSON POST queries the website's international tracking proxy. The parent reference must
match the requested number and contain one waybill with dated scans. Multiple pieces are
rejected because selecting one could return another parcel's progress.

The domestic step, `trawl`, opens the official order-search page in a fresh context and uses its
own search, guest session and service-selected verification branch. The service asks every guest
to click one icon, whatever the browser or network. The current page opens the puzzle as soon as
it has a guest session; the older one asked `needVerify` first, and the helper serves both. Its single-icon worker may refresh up to three
times after uncertain matches, within the same session and lookup deadline. A fourth uncertainty
stops without submitting an answer or sending a history request. Worker failures
and submitted refusals are not retried. Accepted verification must still belong to the original guest session;
only then may the page query `trackNoPin`. The current page first posts
`batchQueryWaybillCheckResult` for the waybill. When the check passes it, the page posts
`trackNoPinNew` with the waybill, session and proof and no phone digits, and only that request
gets through. Otherwise the page asks for the last four digits of the recipient's or sender's
phone, as it does even for a number JD never issued: the helper stops there, and the lookup is
inconclusive with the reason `phone_required`. The helper also permits the normal proxy request
when the service itself selects the branch without verification.
When a prompt mask falls outside the accepted foreground size, verification diagnostics
keep only its pixel count; puzzle images and mask data are not logged.

A declined verification is not remembered: the matcher declines puzzles, not waybills, so the
next lookup opens a fresh session.

Domestic replies require exactly one matching `rawWaybillCode` and an explicit `exists`; the
new search lists it under `obj.trackData` and may leave `exists` out. Only a bound
`exists:false` is not found. Empty or refused replies stay inconclusive, and
browser failure or abstention leaves enabled providers available. No phone, login, map,
attachment or proof-of-delivery route is entered. HTTP recognition never starts this browser
step; browser recognition is a separate opt-in.

The domestic page displays `createTime`, otherwise `trackDay` with `trackTime`. An epoch or
explicit offset keeps its instant. A clock without an offset stays local; the page's language
does not establish its zone. The page lists scans oldest first, and they are read newest first:
mainland China keeps one clock, so local clocks sort as they are. Contact and recipient clauses
are removed from scan wording, a station's phone too, and the place or person a delivery was
handed to. A phrase naming a role (a courier assigned to collect the parcel, a round agreed with
the recipient) keeps the role and the agreed time and drops the person and everything after it.
Each scan keeps its `state` as its provider
code, and the states recorded in `status.ts` give its stage; the newest scan decides the
status. Providers relay these scans without the state or the site's name, and the shared
wording rules read JD Express's collection, arrivals and departures as those states do. Wordless or contact-only rows with
valid clocks are omitted; the remaining history is marked incomplete so enabled providers can
fill it. A reply with no readable scans stays inconclusive. Invalid clocks and malformed rows
still fail, and a capped history is also marked incomplete.

For international history, each scan keeps its operation code as its provider code and takes its stage from it
(`status.ts`); a scan with an unknown code is classified by its wording. An order shipped from
JD's own warehouse abroad is accepted there while it is picked and weighed, then handed to a
last-mile partner such as GOFO, whose steps JD relays. GOFO's label comes under a code JD has
shown with that step alone, and GOFO's loading at a hub, before its delivery station, under the
code of JD's courier out with the parcel, so their wording decides them rather than the code.
On a line from China, the parcel is accepted while JD's warehouse there receives, weighs and
consolidates it. The clearance agent's collection at the port of arrival ("Cleanrance agency
picked") and the hand-over to the local carrier are in transit. The departure from the warehouse
ends with the last-mile partner's number ("Tracking no …"), which becomes the delivery tracking
number and leaves the wording; a row stored with it keeps its row. The number names no partner,
and JD already relays the partner's steps, so it hands nothing off.
The newest scan decides the status. The courier's name and phone are dropped from the out-for-delivery wording
(`wording.ts`).

A scan's location is its city and its country in English. JD names the country in Chinese in
`routeCountry` on some scans, by its full name or a usual short form, and in English in
`routeProvinceName` on its international lanes, so either gives the same name. A country read
neither way stays as written; a province adds nothing. A city that is the country itself, such
as Hong Kong, Macau or Singapore, stands alone.

Each scan's wall clock is local to the scan, whatever zone the request names. A scan also
carries epoch milliseconds and a declared fixed offset (`UTC+3`). It is dated, in that offset,
only when the epoch reads as its wall clock there. Every country its place fields name must
also have a single zone known here, and that zone must keep that offset at that wall clock,
neither skipping nor repeating it. Beside the shared single-zone table, the parser knows Saudi
Arabia, Kuwait, Qatar, Bahrain, Oman, Egypt and Macau, so a Saudi scan is dated at +3 and
stays local at +8. A country spanning several zones (United States, Australia, Indonesia,
Brazil), one not known here, or a country field read neither way keeps the clock local. So does
a place naming no country read here, such as a Chinese province and city without a country or
an abbreviation like `KSA`. Only a scan with no place at all, such as the order's creation, is
dated on its epoch and declared offset alone. A fully dated history is ordered by instant, ties
in JD's order; any local clock keeps JD's order, newest first.

## Limitations

Domestic recovery needs the TRAWL image with the JD helper. Its conservative matcher supports
one observed image geometry and declines other puzzles; it does not promise verification on
every lookup. Public unattended history has been observed for JDJ and JDAZ on the older page;
the current page asked a guest for the last four digits of a phone for every waybill tried, so
the step answers only for a waybill its check passes. Domestic clocks
without a stated offset remain unresolved. Other domestic service variants can require
recipient inputs and are not followed. The international feed's empty
answer remains inconclusive with `portal_not_found`, never proof that a parcel does not exist.
A scan without an epoch is not dated from its declared zone alone.

## Testing

Set `JD_LOGISTICS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/jd-logistics/adapter.live.test.ts`.
