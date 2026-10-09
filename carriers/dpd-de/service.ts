import { createHash, randomBytes } from 'node:crypto';
import type { AdapterEnvironment } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { transportOf } from '../../core/transport/transportOf.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';
import { isRecord } from '../../core/types.js';

// The German DPD app's SOAP service, shared between carriers. DPD Germany tracks parcels
// through it, and DPD Switzerland reads the address of the Pickup shop holding a parcel
// from it: `getParcelShopByID` answers for the group's shops, Swiss ones included.

export const DPD_DE_APP_API = 'https://api.paketnavigator.de/services/v1/Navigator3Service.asmx';
/** The lookup stopped waiting for the session, which keeps opening for the next one. */
export const DPD_DE_SESSION_OPENING = 'session_opening';
const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const SERVICE = 'https://cloud.dpd.com/';
const MAX_BYTES = 2_000_000;
/** Opening a session has taken up to 75 seconds. */
const SESSION_OPEN_MS = 120_000;
/**
 * The service accepts a session for at least eight hours, one left idle for four too. From this
 * age the next one opens beside it, and replaces it once open.
 */
const SESSION_RENEW_MS = 8 * 3_600_000;
/** A kept session that failed to open is tried again after this long. */
const SESSION_RETRY_MS = 15 * 60_000;
/** A host's store has this long to give back its sessions before the service opens one. */
const STORE_LOAD_MS = 5_000;
/**
 * With a store, a session lookups no longer use is checked this often, until the service refuses
 * it twice in a row: while slow, it can refuse a session it accepts again later.
 */
const CHECK_EVERY_MS = 3_600_000;
/** And for at most this long after it opened. */
const CHECK_FOR_MS = 7 * 24 * 3_600_000;
/** A check takes a fraction of a second, and checks of several sessions are this far apart. */
const CHECK_TIMEOUT_MS = 30_000;
const CHECK_GAP_MS = 5_000;
/** A shop id no shop has: the service answers it without a shop, or refuses the session. */
const CHECK_PUDO_ID = 'XX0000';
const TOKEN = /^[A-Za-z0-9+/=]{16,512}$/;
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
/** The service took the session, but confirmed nothing. */
class Unconfirmed extends IndeterminateError {}

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

interface Opening { token: Promise<string>; holders: Set<AbortSignal>; release: () => void }

/** A session as a host keeps it between processes. Times are milliseconds since the epoch. */
export interface DpdSession {
  token: string;
  openedAt: number;
  /** The last time a check found the service accepting it, once lookups no longer used it. */
  checkedAt?: number;
  /** When the service began refusing it, once a second check confirmed it. */
  refusedAt?: number;
}

/**
 * Where a long-lived host keeps the sessions, so that a restart takes the current one up again
 * instead of opening another, and so that how long the service accepts one can be read back
 * from `refusedAt - openedAt`. The service carries on without a store that fails.
 */
export interface DpdSessionStore {
  /** The sessions saved that the service has not refused, in any order. */
  load(): Promise<readonly DpdSession[]>;
  /** Saves a session, replacing what was saved for the same token. */
  save(session: DpdSession): Promise<void>;
}

/** A session lookups no longer use, checked until the service refuses it. */
interface Retired { session: DpdSession; refusedSince?: number }

/** The promise's outcome, or the signal's reason once it aborts first. */
async function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let leave!: () => void;
  const left = new Promise<never>((_resolve, reject) => { leave = () => reject(signal.reason as Error); });
  signal.addEventListener('abort', leave, { once: true });
  try { return await Promise.race([promise, left]); }
  finally { signal.removeEventListener('abort', leave); }
}

/**
 * The service needs an anonymous device session, which it takes tens of seconds to open and then
 * accepts for hours. One is kept per instance, and `sharedDpdAppService` gives the process one
 * instance per transport. The opening runs on its own clock, so a lookup that stops waiting
 * leaves it to the next. A session past its renewal age serves while the next one opens.
 */
export class DpdAppService {
  readonly #partner: DpdDePartner;
  readonly #fetcher?: typeof fetch;
  readonly #userAgent: string;
  readonly #now: () => number;
  readonly #device = randomBytes(8).toString('hex');
  #session: { token: string; openedAt: number } | null = null;
  #opening: Opening | null = null;
  #kept = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #store: DpdSessionStore | undefined;
  #loading: Promise<void> | null = null;
  readonly #retired = new Map<string, Retired>();

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

  /** Whether a lookup would wait for a session to open: none is open. */
  get opening(): boolean {
    return this.#session === null;
  }

  /** Forgets a session the service refused, unless another lookup already replaced it. */
  expire(session: string): void {
    if (this.#session?.token !== session) return;
    this.#retire(this.#session, this.#now());
    this.#session = null;
  }

  /**
   * Keeps a session open from now on, for a long-lived host: one opens at once if there is none,
   * and the next before the current one lapses. Openings then run whether or not a lookup waits
   * for them. With a store, the current session saved there is taken up again instead, and the
   * sessions lookups no longer use are checked until the service refuses them. The timers do not
   * keep the process alive.
   */
  keep(store?: DpdSessionStore): void {
    if (this.#kept) return;
    this.#kept = true;
    this.#store = store;
    if (!store) return this.#renew();
    this.#loading = this.#load(store).finally(() => {
      this.#loading = null;
      this.#renew();
      this.#follow();
    });
  }

  /** Takes up the newest saved session while it is younger than the renewal age, and follows the others. */
  async #load(store: DpdSessionStore): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The store did not answer')), STORE_LOAD_MS); });
    let saved: readonly DpdSession[];
    try { saved = await Promise.race([Promise.resolve().then(() => store.load()), late]); }
    catch { return; }
    finally { clearTimeout(timer); }
    const now = this.#now();
    const sessions = (Array.isArray(saved) ? saved as readonly unknown[] : [])
      .filter((session): session is DpdSession => isRecord(session) && typeof session.token === 'string' && TOKEN.test(session.token)
        && typeof session.openedAt === 'number' && session.openedAt <= now && now - session.openedAt < CHECK_FOR_MS
        && session.refusedAt == null)
      .sort((left, right) => right.openedAt - left.openedAt);
    const [newest, ...older] = sessions;
    if (newest && !this.#session && now - newest.openedAt < SESSION_RENEW_MS) this.#session = { token: newest.token, openedAt: newest.openedAt };
    else if (newest) older.unshift(newest);
    for (const session of older) this.#retired.set(session.token, { session: { ...session } });
  }

  /** Saves a session's state in the host's store, if there is one, without waiting for it. */
  #save(session: DpdSession): void {
    const store = this.#store;
    if (store) void Promise.resolve().then(() => store.save({ ...session })).catch(() => undefined);
  }

  /** Follows a session lookups no longer use, when a store keeps what its checks find. */
  #retire(session: { token: string; openedAt: number }, refusedAt?: number): void {
    if (this.#store && !this.#retired.has(session.token)) this.#retired.set(session.token, { session: { ...session }, refusedSince: refusedAt });
  }

  /** Checks the sessions lookups no longer use, every hour. */
  #follow(): void {
    const timer = setTimeout(() => void this.#check().finally(() => this.#follow()), CHECK_EVERY_MS);
    timer.unref?.();
  }

  /**
   * Asks the service once for each followed session whether it still accepts it. A refusal
   * confirmed by the next check is saved as the time it began; a reply that is not about the
   * session says nothing.
   */
  async #check(): Promise<void> {
    let first = true;
    for (const [token, retired] of [...this.#retired]) {
      const now = this.#now();
      if (now - retired.session.openedAt >= CHECK_FOR_MS) { this.#retired.delete(token); continue; }
      if (!first) await new Promise<void>((resolve) => { setTimeout(resolve, CHECK_GAP_MS).unref?.(); });
      first = false;
      let accepted: boolean;
      try {
        await this.call('getParcelShopByID', { SessionToken: token, ParcelShopID: '0', PudoID: CHECK_PUDO_ID, ParcelShopOnly: 'false' },
          AbortSignal.timeout(CHECK_TIMEOUT_MS), CHECK_TIMEOUT_MS);
        accepted = true;
      } catch (error) {
        if (error instanceof SessionExpired) accepted = false;
        else if (error instanceof Unconfirmed) accepted = true;
        else continue;
      }
      if (accepted) {
        retired.refusedSince = undefined;
        retired.session.checkedAt = this.#now();
        this.#save(retired.session);
      } else if (retired.refusedSince === undefined) {
        retired.refusedSince = this.#now();
      } else {
        retired.session.refusedAt = retired.refusedSince;
        this.#retired.delete(token);
        this.#save(retired.session);
      }
    }
  }

  /** Opens the next session if the current one is due, or waits until it is. */
  #renew(): void {
    if (this.#opening) return;
    const age = this.#session ? this.#now() - this.#session.openedAt : Infinity;
    if (age < SESSION_RENEW_MS) this.#schedule(SESSION_RENEW_MS - age);
    else this.#opening = this.#open();
  }

  #schedule(ms: number): void {
    if (!this.#kept) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#renew(), ms);
    this.#timer.unref?.();
  }

  /** An opening, which a kept service finishes and otherwise ends when no lookup holds it. */
  #open(): Opening {
    const controller = new AbortController();
    const holders = new Set<AbortSignal>();
    const token = this.call('getSessionFullState', { SessionToken: '', DeviceData: {
      HardwareID: this.#device, BootSystemID: 'Android_Phone', Version: '15', AppVersion: '4.2.0',
    } }, controller.signal, SESSION_OPEN_MS).then(result => {
      const value = scalar(one(result, 'SessionFullState'), 'SessionToken', 600);
      if (!TOKEN.test(value)) invalid();
      if (this.#session) this.#retire(this.#session);
      this.#session = { token: value, openedAt: this.#now() };
      this.#save(this.#session);
      return value;
    });
    const release = () => {
      for (const holder of holders) if (holder.aborted) holders.delete(holder);
      if (!holders.size && !this.#kept) controller.abort(new Error('No lookup is waiting for the DPD Germany session'));
    };
    const opening = { token, holders, release };
    void token.then(() => this.#schedule(SESSION_RENEW_MS), () => this.#schedule(SESSION_RETRY_MS)).finally(() => {
      if (this.#opening === opening) this.#opening = null;
      for (const holder of holders) holder.removeEventListener('abort', release);
    });
    return opening;
  }

  /**
   * One session for every lookup. The opening runs while a lookup that asked for it is still
   * running, even one that stopped waiting; each lookup waits until its signal or `waitMs` ends.
   * A session past its renewal age answers at once while the next one opens. `waiting` is called
   * when the lookup starts waiting for an opening, once a host's store has given back its sessions.
   */
  async session(signal: AbortSignal, waitMs: number, waiting?: () => void): Promise<string> {
    if (this.#loading) await until(this.#loading, signal);
    const current = this.#session;
    const due = !current || this.#now() - current.openedAt >= SESSION_RENEW_MS;
    if (current && !due) return current.token;
    signal.throwIfAborted();
    const opening = this.#opening ??= this.#open();
    const { token, holders, release } = opening;
    if (!holders.has(signal)) {
      holders.add(signal);
      signal.addEventListener('abort', release, { once: true });
    }
    if (current) return current.token;
    waiting?.();
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
    if (scalar(result, 'Ack', 8) !== 'true') throw new Unconfirmed('DPD Germany', 'DPD Germany returned no confirmed parcel');
    return result;
  }
}

const services = new WeakMap<object, Map<string, DpdAppService>>();
const GLOBAL_FETCH = {};

/**
 * The process's service for a transport and user agent. DPD Germany and DPD Switzerland share it,
 * and so do the adapters of every registry and tracker, so a session opens once for all of them.
 * A tracker's wrapper only adds each lookup's signal, so the service is that of the fetcher under it.
 */
export function sharedDpdAppService(options: Pick<AdapterEnvironment, 'fetcher' | 'userAgent'> = {}): DpdAppService {
  const userAgent = userAgentOf(options.userAgent);
  const fetcher = transportOf(options.fetcher);
  const key = fetcher ?? GLOBAL_FETCH;
  let byAgent = services.get(key);
  if (!byAgent) services.set(key, byAgent = new Map<string, DpdAppService>());
  let service = byAgent.get(userAgent);
  if (!service) byAgent.set(userAgent, service = new DpdAppService({ fetcher, userAgent }));
  return service;
}

/**
 * Opens the session DPD Germany and DPD Switzerland read the German DPD app's service with, in the
 * background, and keeps one open for the life of the process, so that no lookup waits the tens of
 * seconds an opening takes. For a long-lived host, with the `fetcher` and `userAgent` it gives
 * `createTracker` or its adapter environment. With a `store`, a restart takes the saved session up
 * again, and the sessions no longer used are checked every hour until the service refuses them,
 * which the store records. The timers do not keep the process alive.
 */
export function warmDpdSession(environment: Pick<AdapterEnvironment, 'fetcher' | 'userAgent'> = {},
  options: { store?: DpdSessionStore } = {}): void {
  sharedDpdAppService(environment).keep(options.store);
}
