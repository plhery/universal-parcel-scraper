/**
 * AWS WAF's mark on a reply it acted on. Internal to adapters, not a public export. The firewall
 * names its action in `x-amzn-waf-action`, `challenge` for the script check, often with HTTP 202,
 * and `captcha` for the picture check, often with HTTP 405.
 */

/**
 * The action AWS WAF named, `''` when the header is there but empty, and null without it. Takes a
 * fetch reply's headers or a browser capture's, whose names are lower case.
 */
export function awsWafAction(headers: Pick<Headers, 'get'> | Readonly<Record<string, string>>): string | null {
  // A host's own fetcher may answer with another library's Headers, so its shape decides.
  return typeof headers.get === 'function' ? (headers as Headers).get('x-amzn-waf-action')
    : (headers as Readonly<Record<string, string>>)['x-amzn-waf-action'] ?? null;
}
