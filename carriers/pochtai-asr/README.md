# Pochtai Asr

Pochtai Asr delivers documents, parcels and cargo in Tajikistan and abroad. The adapter
reads the JSON API used by the carrier's guest tracker and requires the full waybill
in its response. Only the API's specific shipment-not-found reply means the waybill is
missing.

Scan times keep the offsets the carrier supplies. The adapter shows the requested English,
Russian or Tajik wording when available and omits shipment notes. The catalog opens the
search form, where the carrier expects the printed hyphen in the waybill.

Run the live test with `POCHTAI_ASR_NUMBER` supplied in the environment and
`npm run test:carriers:live -- carriers/pochtai-asr`.
