# Swire Shipping

Swire Shipping, the trading name of The China Navigation Company, runs container and break bulk
lines across the Pacific, between Asia, Oceania, the Pacific Islands and the Americas. Tracked
through the tracking page of its online portal.

## How it works

1. `direct`: the tracking page on `online.swireshipping.com` is a Blazor Server app on ASP.NET
   Core 8, with no account. Its HTML is an empty shell, and the server renders the page over a
   SignalR connection, which the adapter holds over HTTP long polling with no browser, cookie,
   token or key:
   - `GET /tracking?type={bl|container}&query={number}`, the shell, which names the two
     components to start and carries their state.
   - `POST /_blazor/negotiate?negotiateVersion=1`, then polls and posts on
     `/_blazor?id={token}`: the `blazorpack` handshake, `StartCircuit` with the page's address,
     its components and their state, then each render batch, acknowledged as the browser does,
     until the page answers.
   - `DELETE` on the same address, so the server drops the circuit at once.

- The shared Blazor Server client holds the connection, in
  [`blazorCircuit.ts`](../../core/transport/blazorCircuit.ts).
- The page looks the number up as it opens, under Telerik's loader, and renders its answer
  once the loader is gone; the adapter reads it then.
- The page asks whether it runs on a phone and whether the window matches each of its widgets'
  media queries. The circuit fails on an answer that is not a boolean, so the adapter answers
  `false` to both; other calls are answered as done.
- An unknown number gets `We are unable to find details for {number} …` under the search box.
  The sentence for another number is inconclusive.
- A 403 in place of the shell is a challenge and a 429 is rate limited. A rendering error, a
  closed connection or a page that never answers is a failure, not a missing parcel.
- There is no recognition. No detection rule names Swire Shipping, so preflight never offers it
  a number, and each lookup is a connection of several requests.

## Notes

- A bill's page lists its containers. It opens one with its moves and shows each other one's
  latest move only; opening another needs a click, so such a bill is marked truncated. A
  container looked up on its own gets all its moves.
- The page lists the moves made and the moves planned, each marked; the planned ones are not
  events.
- The page marks a bill `DELIVERED` once its containers are discharged. The adapter stages the
  bill from the containers' moves instead: a gate move after the container sailed is transit,
  and before its discharge at its port a full container leaving a terminal is transit and an
  empty one returned is no delivery. Of a container shown by its latest move only, a move at
  the bill's port of loading or place of receipt is on the way out. The bill is delivered once
  each container is returned empty.
- Moves keep the page's day and minute. The page names each port with its UN/LOCODE; a port
  whose country keeps one zone, and the ports listed in the parser, give an instant. Others
  keep the wall clock.
- Moves the containers share at one minute and place are kept once.

## Limitations

- The other containers' histories, the vessel, the ports of the route and the estimated
  arrival are not read. There is no sender, recipient or proof of delivery.

## Numbers

A bill is two letters for the country of its port of loading and eight digits. US import
records file Swire's Pacific Islands bills under PLLU, which the adapter removes. The adapter
also tracks an ISO 6346 container number. Other shapes are refused. The samples and their
sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/swire-shipping`, with `SWIRE_SHIPPING_TRACKING_NUMBER`
and optionally `SWIRE_SHIPPING_UNKNOWN_NUMBER` set outside the repository.
