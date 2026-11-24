# Rodonaves

Rodonaves Transportes e Encomendas LTDA, formerly RTE Rodonaves, is a road carrier based in Ribeirão
Preto that carries part loads and parcels across Brazil, with express and air services. Tracked by
protocol or minuta number through the two lookups its tracking page makes.

## How it works

1. `direct`: the two lookups of the tracking page at `rodonaves.com.br/rastreio-de-mercadoria`,
   in its order:
   - `GET https://rodonaves.com.br/bin/rodonaves/trackingv3/package?ProtocolNumber={number}`,
     the road system. It answers a number it holds with the protocol, its freight document and
     its events, and one it does not hold with HTTP 204 and no body.
   - Unless the road system gave events,
     `GET https://rodonaves.com.br/bin/rodonaves/trackingv3/brudam?codigo={number}&prefixo=minuta`,
     Brudam, the system of the Rodo Aéreo services. It answers with one record for the minuta:
     its delivery estimate and its occurrences, newest first.

   Neither needs a cookie or a key. The page sends a reCAPTCHA v3 token with each lookup; the
   lookups do not check it, so the adapter sends none.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- The number is missing only when the road system answers with no content and Brudam answers
  "Erro na consulta do documento.", which the page shows as "Nenhum pedido encontrado.". A road
  lookup that failed, a refusal of either servlet (`success: false`), an empty Brudam reply and
  any other Brudam message keep the answer open. A protocol the road system lists without events
  is listed without history.
- Both replies name the number they answer for; an answer for another number is inconclusive.
- The road system gets at most two thirds of the time, so Brudam is always asked.

## Notes

- Clocks carry no zone and stay local times.
- Road events are staged as the page groups them: by event and Proceda code for a scheduled or
  completed collection and the start of the transport (`E501`, `E503`, `E0`), otherwise by step id
  (`H<id>`). Brudam occurrences are staged by their code. The page's own wording for each group is
  in [`statuses.json`](statuses.json).
- Brudam also lists billing records and customer-service tickets about the minuta. They are not
  parcel events and are left out, as are exact repeats, which Brudam writes for each leg of a
  flight. Its catch-all occurrence and the proof-of-delivery removal move nothing.
- Brudam can write an airline record after the delivery, such as an air waybill ready for
  collection. The attached proof of delivery, written later still, keeps such a shipment
  delivered.
- An airport code in brackets at the end of a Brudam occurrence becomes the scan's location.
- The estimate is Brudam's `prev_entrega`, or for the road system the later of the rescheduled
  date and the emission date plus the working days it states, as the page computes it. It is
  dropped once the shipment is delivered.
- The service is "Rodoviário" for the road system, and for Brudam "Rodo Aéreo ECO" for its
  ECONOMICO service and "Rodo Aéreo" for the others, as the page names them.
- Both replies name the sender and the recipient, masked in Brudam's. They are never read, nor
  are the freight document's numbers.

## Limitations

- No public road protocol is known, so the road reply is read in the shape the page's script
  reads and tested on a synthetic reply.
- Tracking by invoice or CT-e number needs the sender's or recipient's CPF or CNPJ and is not
  used.
- Minutas have six digits, a shape many carriers share, so no rule claims them and preflight does
  not ask Rodonaves. A number reaches the adapter when it is filed under Rodonaves or opened from
  a Rodonaves link.

## Numbers

The page takes a protocol or minuta number of up to twelve digits. Customers name minutas in
public complaints; the samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page looks up the number in its address on load:
`rodonaves.com.br/rastreio-de-mercadoria?rastreiemercadoria=1&protocolo={number}` for a protocol
and `?rastreiemercadoria=4&minuta={number}` for a minuta. The library reads the number from both.
The page's invoice and CT-e links also carry a CPF or CNPJ and are not read.

## Testing

`npm run test:carriers:live -- carriers/rodonaves`, with `RODONAVES_TRACKING_NUMBER` and
optionally `RODONAVES_UNKNOWN_NUMBER` set outside the repository.
