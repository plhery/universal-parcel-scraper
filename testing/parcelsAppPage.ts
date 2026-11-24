const PAGE = 'https://parcelsapp.com/en/tracking/';

/**
 * Answers ParcelsApp's tracking page, which issues the ticket its API asks
 * for, with a synthetic ticket, and passes every other request to `fetcher`,
 * so a test's mock sees only the API and the other sources.
 */
export const withParcelsAppPage = (fetcher: typeof fetch): typeof fetch => (input, init) =>
  (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).startsWith(PAGE)
    ? Promise.resolve(new Response('<script>window.parcelsTicket = "MS4xNzAwMDAwMDAwLmFiY2Q.0123456789abcdef";</script>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    : fetcher(input, init);
