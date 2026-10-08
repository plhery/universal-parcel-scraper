import { createHash, randomBytes } from 'node:crypto';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';

// The German DPD app's SOAP service, shared between carriers. DPD Germany tracks parcels
// through it, and DPD Switzerland reads the address of the Pickup shop holding a parcel
// from it: `getParcelShopByID` answers for the group's shops, Swiss ones included.

export const DPD_DE_APP_API = 'https://api.paketnavigator.de/services/v1/Navigator3Service.asmx';
/** The lookup stopped waiting for the session, which keeps opening for the next one. */
export const DPD_DE_SESSION_OPENING = 'session_opening';
const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const SERVICE = 'https://cloud.dpd.com/';
const MAX_BYTES = 2_000_000;
/** Opening a session has taken up to 42 seconds. */
const SESSION_OPEN_MS = 75_000;
// Shared partner credentials of the public app, distributed with the maintainer's approval.
const PARTNER: DpdDePartner = { name: 'Android Paketnavigator3', token: 'A33363237662F5945576', password: '272 WetFd2mpXrgD' };

export interface DpdDePartner { name: string; token: string; password: string }

export function invalid(): never { throw new SchemaError('DPD Germany', 'DPD Germany returned invalid tracking XML'); }

export function children(node: XmlNode, name: string, uri = SERVICE): XmlNode[] {
  return node.children.filter(child => child.name === name && child.uri === uri);
}

export function one(node: XmlNode, name: string, uri = SERVICE): XmlNode {
  const matches = children(node, name, uri);
  return matches.length === 1 ? matches[0]! : invalid();
}

export function scalar(node: XmlNode, name: string, max = 200): string {
  const matches = children(node, name);
  if (matches.length > 1 || matches[0]?.children.length) invalid();
  return clean(matches[0]?.text ?? '', max);
}

export function optional(node: XmlNode, name: string): XmlNode | undefined {
  const matches = children(node, name);
  if (matches.length > 1) invalid();
  return matches[0];
}

const escaped = (value: string) => value.replace(/[<>&"']/g, character => `&#${character.charCodeAt(0)};`);

type Fields = { readonly [name: string]: string | Fields };
const elements = (fields: Fields): string => Object.entries(fields)
  .map(([name, value]) => `<${name}>${typeof value === 'string' ? escaped(value) : elements(value)}</${name}>`).join('');

/** The service no longer accepts the session. */
export class SessionExpired extends Error {}
/** DPD does not hold the postcode to be the recipient's. */
export class PostcodeRejected extends Error {}

/** A Pickup shop as its own record names it: its name, then its street and its town on a line each. */
export interface DpdParcelShop { name: string; address: string }

/** The shop that `getParcelShopByID` returns, if it is the requested one and has a street and a town. */
function shopOf(result: XmlNode, id: string): DpdParcelShop | undefined {
  const shop = one(result, 'ParcelShop');
  if (scalar(shop, 'PUDOID', 40) !== id) return undefined;
  const address = one(shop, 'ShopAddress');
  const street = scalar(address, 'Street', 120);
  const city = scalar(address, 'City', 80);
  if (!street || !city) return undefined;
  return {
    name: scalar(address, 'Company', 120),
    address: `${[street, scalar(address, 'HouseNo', 20)].filter(Boolean).join(' ')}\n${[scalar(address, 'ZipCode', 16), city].filter(Boolean).join(' ')}`,
  };
}

/**
 * The service needs an anonymous device session, which it takes tens of seconds to open and then
 * accepts for hours: one is kept per instance. The opening runs on its own clock, so a lookup that
 * stops waiting leaves it to the next.
 */
export class DpdAppService {
  readonly #partner: DpdDePartner;
  readonly #fetcher?: typeof fetch;
  readonly #userAgent: string;
  readonly #now: () => number;
  readonly #device = randomBytes(8).toString('hex');
  #session = '';
  #opening: { token: Promise<string>; holders: Set<AbortSignal>; release: () => void } | null = null;

  constructor(options: { partner?: DpdDePartner; fetcher?: typeof fetch; userAgent?: string; now?: () => number } = {}) {
    this.#partner = options.partner ?? PARTNER;
    this.#fetcher = options.fetcher;
    this.#userAgent = userAgentOf(options.userAgent);
    this.#now = options.now ?? Date.now;
  }

  /**
   * The Pickup shop with this PUDO id, or nothing when the service does not answer it within
   * `timeoutMs`, including the wait for a session. Only the signal ends it with an error.
   */
  async parcelShop(id: string, options: { signal: AbortSignal; timeoutMs: number }): Promise<DpdParcelShop | undefined> {
    const deadline = performance.now() + options.timeoutMs;
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    try {
      for (let attempt = 0; ; attempt += 1) {
        const session = await this.session(options.signal, left());
        try {
          return shopOf(await this.call('getParcelShopByID', { SessionToken: session, ParcelShopID: '0', PudoID: id,
            ParcelShopOnly: 'false' }, options.signal, left()), id);
        } catch (error) {
          if (!(error instanceof SessionExpired) || attempt) throw error;
          this.expire(session);
        }
      }
    } catch {
      options.signal.throwIfAborted();
      return undefined;
    }
  }

  /** Forgets a session the service refused, unless another lookup already replaced it. */
  expire(session: string): void {
    if (this.#session === session) this.#session = '';
  }

  /**
   * One session for every lookup. The opening runs while a lookup that asked for it is still
   * running, even one that stopped waiting; each lookup waits until its signal or `waitMs` ends.
   */
  async session(signal: AbortSignal, waitMs: number): Promise<string> {
    if (this.#session) return this.#session;
    signal.throwIfAborted();
    if (!this.#opening) {
      const controller = new AbortController();
      const holders = new Set<AbortSignal>();
      const token = this.call('getSessionFullState', { SessionToken: '', DeviceData: {
        HardwareID: this.#device, BootSystemID: 'Android_Phone', Version: '15', AppVersion: '4.2.0',
      } }, controller.signal, SESSION_OPEN_MS).then(result => {
        const value = scalar(one(result, 'SessionFullState'), 'SessionToken', 600);
        if (!/^[A-Za-z0-9+/=]{16,512}$/.test(value)) invalid();
        return this.#session = value;
      });
      const release = () => {
        for (const holder of holders) if (holder.aborted) holders.delete(holder);
        if (!holders.size) controller.abort(new Error('No lookup is waiting for the DPD Germany session'));
      };
      const opening = { token, holders, release };
      this.#opening = opening;
      void token.catch(() => undefined).finally(() => {
        if (this.#opening === opening) this.#opening = null;
        for (const holder of holders) holder.removeEventListener('abort', release);
      });
    }
    const { token, holders, release } = this.#opening;
    if (!holders.has(signal)) {
      holders.add(signal);
      signal.addEventListener('abort', release, { once: true });
    }
    let leave!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const left = new Promise<never>((_resolve, reject) => {
      leave = () => reject(signal.reason as Error);
      timer = setTimeout(() => reject(new IndeterminateError('DPD Germany', 'DPD Germany app session is still opening', {
        reason: DPD_DE_SESSION_OPENING,
      })), Math.max(0, Math.min(waitMs, SESSION_OPEN_MS)));
    });
    signal.addEventListener('abort', leave, { once: true });
    try { return await Promise.race([token, left]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', leave); }
  }

  async call(operation: string, fields: Fields, signal: AbortSignal, timeoutMs: number): Promise<XmlNode> {
    // The service checks a key derived from the minute of the UTC day.
    const now = new Date(this.#now());
    const phase = String((now.getUTCHours() * 60 + now.getUTCMinutes() + 1000) * 3);
    const key = phase + createHash('md5').update(`${phase}${this.#partner.name}0${operation}${this.#partner.password}`).digest('base64').slice(0, 16);
    const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${SOAP}"><soap:Body><${operation} xmlns="${SERVICE}"><${operation}Request>${elements({
      Version: '100', Language: 'de_EN', PartnerCredentials: { Name: this.#partner.name, Token: this.#partner.token, KeyPhase: key }, ...fields,
    })}</${operation}Request></${operation}></soap:Body></soap:Envelope>`;
    const { response, bytes } = await fetchBounded(DPD_DE_APP_API, { method: 'POST', signal, body,
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${SERVICE}${operation}"`, Accept: 'text/xml', 'User-Agent': this.#userAgent } }, {
      provider: 'DPD Germany', maxBytes: MAX_BYTES, timeoutMs, fetcher: this.#fetcher, allowHttpStatuses: [404, 410],
    });
    if (response.status !== 200) throw new TransportError('DPD Germany', 'DPD Germany app service is unavailable', { status: response.status });
    const root = xmlDocument(decodeText(bytes), MAX_BYTES) ?? invalid();
    if (root.name !== 'Envelope' || root.uri !== SOAP) invalid();
    const result = one(one(one(root, 'Body', SOAP), `${operation}Response`), `${operation}Result`);
    const codes = children(result, 'ErrorDataList').flatMap(list => children(list, 'ErrorData')).map(error => scalar(error, 'ErrorCode', 80));
    if (codes.some(code => code === 'ERROR_PARTNER' || code === 'ERROR_KEYPHASE')) {
      throw new ChallengeError('DPD Germany', 'DPD Germany refused the app credential');
    }
    if (codes.includes('ERROR_SESSION_NOT_VALID')) throw new SessionExpired();
    if (codes.includes('ERROR_TRACKING_DELIVERYZIPCODE_NOT_VALID')) throw new PostcodeRejected();
    // "No tracking data" also answers for parcels the scan list still knows: it proves no absence.
    if (scalar(result, 'Ack', 8) !== 'true') throw new IndeterminateError('DPD Germany', 'DPD Germany returned no confirmed parcel');
    return result;
  }
}
