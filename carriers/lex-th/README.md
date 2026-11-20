# LEX Thailand

The adapter covers Lazada's Thai delivery network when LEX Thailand is selected.

## Retrieval

The public page posts one parcel number in `trackingNumbers` to `lex.th/api/search_packages`.
The adapter shares the LEX Indonesia client and status map. It checks the whole number in the
reply and requires at least one leg to name LEX TH. An empty package list means no record. The
client retries once after a network failure within the same lookup budget.

The guest endpoint gives the current status alone. The detailed history asks for the recipient's
phone digits. The site can return a slider check, which the client reports as a challenge.

## Numbers

Lazada parcels that LEX delivers in Thailand carry LEXPU or LEXDO and ten digits, which rule
`lex-th-1` suggests LEX Thailand for. LEX numbers differ by country, and these have been seen in
Thailand alone, so the rule stays low.

## Testing

`LEX_TH_TRACKING_NUMBER=… LEX_TH_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/lex-th`
