# Azerpost

Azerpost is Azerbaijan's national post. Its tracker on azerpost.az answers with the postal
union's IPS record of the item.

## Numbers

Azerpost prints UPU S10 numbers ending in `AZ`; its tracking page gives a `CP` parcel as its
example, and archived lookups on its former tracker show items starting `SS`, `BB`, `RR`, `CP`
and other prefixes. Generic postal detection handles S10 numbers, so Azerpost has no rule of
its own. The adapter takes any S10 code with a valid check digit, as IPS keeps items from
abroad under the sending post's code. The samples and their sources are in
[`numbers.json`](numbers.json).

## Retrieval

1. `direct`: one multipart `POST https://www.azerpost.az/api/get-package/en` with `package_id`
   and an empty `g_token`, as the tracking page's script posts it. The script also takes a CSRF
   token from `/api/get-csrf` and asks reCAPTCHA v3 for `g_token`; the endpoint checks neither
   and keeps no session, so the adapter sends no cookie or token. The last path segment sets the
   language of the event names.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of it.

The record names the item's code, its weight in kilograms, mail class, contents, origin and
destination countries, a postal status and its scans, oldest first, each with an event name, a
date, an office and a condition code. The adapter keeps the scans newest first, the weight and
the destination. The mail class, the contents, the origin and the condition codes are left
out, and so is the postal status: it says `Arrived` whatever the scans say. A delivery followed
by who took the item, as the former tracker wrote it, keeps the event's name alone. The record
must name the whole code asked; another code is inconclusive. A record without scans is a listed
item without history.

A code IPS does not know gets `Tracking number not found` with the address of the backend
lookup, which ends with the code. It is read as not found when that code is the one asked, or
when the reply names no address, since it answers the one request that posted the number. A
reply naming another code is inconclusive. A refusal of the page's tokens, the F5 firewall's
rejection page, HTTP 403 and Laravel's expired-session 419 are challenges. A rate limit stays a
rate limit, a server failure is inconclusive or a transport failure, and a refusal of other
fields or any other reply is a changed reply, never a missing item.

There is no recognition: no detection rule offers Azerpost for a number, so preflight never asks
it.

## Clocks

IPS dates each scan on its office's wall clock, without an offset. The adapter keeps it as the
scan's `local_time`, to the second, and the catalog marks the carrier's clocks as local, so a
scan is dated by the office it names: Azerbaijan's on Baku's clock, UTC+04:00, and an office
abroad on its own. The office is written code first, `AZ1000, Bakı` for IPS's `Bakı: AZ1000`:
written the other way it also reads as Bakı in Indonesia, and a foreign office of exchange such
as `TRISTE` is placed by its code. A date with a stated offset keeps it.

## Limitations

- Only items posted in Azerbaijan have been seen answered, with the scans of Azerbaijan's
  offices. Items from abroad are accepted but none has been seen.
- Older items age out: those from the former tracker's archived lookups answer not found.
- No delivery estimate, service name, proof of delivery or delivery address.

## Links

The tracking page reads the number from its `package_id` parameter in Azerbaijani, English and
Russian, and the home page's search form builds that address. The former tracker opened one
parcel at `/az/tracking/{number}` or `/en/tracking/{number}`; those addresses now return an
error.

## Testing

The live test reads the newest confirmed sample from `numbers.json`:

```sh
npm run test:carriers:live -- carriers/azerpost
```
