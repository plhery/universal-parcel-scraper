# Hongkong Post

Reads the scan history of checksum-valid postal item numbers ending in `HK` from Hongkong
Post's [official tracker](https://webapp.hongkongpost.hk/en/mail_tracking2/index.html), and
falls back to the latest status from its enquiry chatbot (Talk2Elain).

## How it works

1. `website`: the tracker's own lookup. Its page asks MTCaptcha for a token before each
   search. The adapter does what the widget does over HTTP (`core/transport/mtcaptcha.ts`):
   it opens a challenge, reads its picture with the shared text model, computes the
   widget's proof of work and typing record, waits as long as the challenge asks and
   sends the answer. The token is good for one request, which posts the number to
   `webapp1.hongkongpost.hk/api1/v1/mailTracking/mail-tracking-message-mtCaptcha` as the
   page does (`lang: "E"`, `path: "2"`, a random eight-character `b`).
2. `direct`: one chatbot session per lookup, under a fresh random session id. Each input
   is posted to `https://chatbot.hongkongpost.hk/mw/web`; the bot's reply comes from
   `https://chatbot.hongkongpost.hk/mw/web/longPoll`, one message per poll. The adapter
   walks the scripted menu (`init`, English, Mail Tracing and Compensation, Mail Tracing),
   checks that each reply offers the expected option under its expected label and that the
   last one asks for a tracking number, then sends the number. An idle poll ends with HTTP
   408. Like the official client, the adapter polls again after it, or after a reply
   without a message, a bounded number of times within the budget. A session end or a
   hand-over to live chat stops the lookup.

The chatbot runs when the tracker refuses the token, fails, or finds the item without
its scans, and keeps a third of the budget (at most 15 s) for that. Below 15 s the
chatbot answers alone. The tracker's not-found is final: the chatbot gives the same.

## Notes

- MTCaptcha refuses an answer sent before the challenge's wait, a few seconds, or one
  whose typing record does not spell it. A picture whose reading has the wrong length
  is replaced rather than answered, and a lookup reads at most eight. Most lookups pass
  on the first or second picture.
- The tracker keys its reply by the number and repeats it as `itemNo`. `result: "-1"` is
  not found, also for an item past its enquiry period. `check_auth: false` is a refused
  token.
- Each scan's clock is local where it happened, and the tracker names that place by its
  country. A scan in Hong Kong or in a single-zone country gets its instant from that
  country's zone (`time_zone_basis: place`); elsewhere only the wall clock is kept.
- The chatbot's answer does not repeat the number. It is bound to the lookup because the
  session is new, carries only this number, sends it once as its last input, and the answer
  is the first message after it. A menu, prompt or "information entered is incorrect"
  reply in its place is a changed menu, never a not-found. "The system has no record of the
  mail item enquired" is not found; "Invalid Mail Number!" is an invalid number. Its status
  clock (`as at DD-MM-YYYY HH:mm`) is the latest event's local time, without a place, so it
  stays in `last_update_local`.
- Known wordings map through `status.ts`; others fall to the shared wording rules, and stay
  unmapped when those don't know them either.

## Other tracking routes

The older `MailTracking_app3/latestResult` route remains in the public page's client code.
The Android app `com.hkpost.android` links to the same chatbot. Its guest session
(`m.hongkongpost.hk/api/sign-in`, then a JWT) needs no account, but its tracking SOAP
calls (`MailTrackDetailCapt`, `MailTrackingRecordCapt`) refuse a request without a Tencent
Cloud CAPTCHA ticket. The [Mail Service API](https://ec-ship.hongkongpost.hk/API-portal/index.jsp?lang=en_us)
requires registration. None of them is used.

## Limitations

- No delivery estimate, and no offset where the scan's country keeps several zones.
- Only `S10` numbers ending in `HK`.
- Outbound tracking beyond departure from Hong Kong depends on the destination's
  postal service.
- The chatbot gives the latest status only, and a reworded or reordered menu fails until
  the expected labels are updated.

## Testing

`npm run test:carriers:live -- carriers/hongkong-post` sends a well-formed unknown number.
Set `HONGKONG_POST_TRACKING_NUMBER` to a real number to read its history through the
tracker.
