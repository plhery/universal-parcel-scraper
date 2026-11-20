# Honducor

The adapter supports Honducor's international postal history, including events reported by
foreign posts. Other services retain enabled provider fallback. It is used when the caller selects Honducor; a postal number alone does not
establish that Honducor carries it.

The adapter opens the [tracking form](https://rastreo.honducor.gob.hn/) in an anonymous
session. It obtains a signed ALTCHA challenge and computes the SHA-256 answer used by the
[public widget](https://rastreo.honducor.gob.hn/postal_trace/static/lib/altcha/altcha.min.js),
then posts the whole reference. Only the native result redirect for that same reference is
followed. Work, bytes and requests stay inside the caller's budget; a costlier or changed
challenge remains a challenge.

The result's own reference must match and its history must include a Honduras postal office.
Foreign-only history stays inconclusive. This expensive check is not offered as automatic
number recognition. Every displayed clock is retained. Any timezone inferred by the consumer stays labelled
beside that clock; the adapter applies no blanket Honduras offset. Postal office codes and the operational wording stay; recipient names,
bag details and the page's query clock are omitted. An empty or unfinished result is
inconclusive, so enabled providers can still answer.

Run live retrieval with `HONDUCOR_TEST_NUMBER` set outside Git:

```sh
npm run test:live -- carriers/honducor/adapter.live.test.ts
```
