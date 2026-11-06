import type { CarrierResult } from '../result/index.js';
import { NOOP_RECORDER, type StepRecord, type StepRecorder } from '../telemetry/index.js';

export function retryShare(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new TypeError('Browser retry share must be between zero and one');
  return value;
}

export type AlternativeRoute = Exclude<NonNullable<StepRecord['networkRoute']>, 'default'>;

/** One lookup's opt-in route assignment. The adapter owns eligibility, attempts and deadlines. */
export class BrowserRouteTrial<T> {
  readonly recorder: StepRecorder;
  private selected: 'default' | AlternativeRoute | undefined;
  private pending = false;
  private route: StepRecord['networkRoute'] = 'default';
  private attempt: StepRecord['networkAttempt'] = 'initial';
  private family: StepRecord['networkFamily'] = 'unknown';
  private bytes: number | undefined;
  private history = false;
  private partial = false;

  constructor(private readonly options: { primary: T; alternative: T | null; route: 'residential'; share: number;
    steps: readonly string[]; recorder?: StepRecorder;
    /** Routes a caller's own allocation can name at the retry, in place of the share's lottery. */
    routes?: Partial<Record<AlternativeRoute, T | null>> }) {
    retryShare(options.share);
    const sink = options.recorder ?? NOOP_RECORDER;
    this.recorder = {
      step: record => {
        const observed = this.pending && options.steps.includes(record.step);
        this.pending = false;
        sink.step(observed ? { ...record, networkRoute: this.route, networkAttempt: this.attempt,
          networkFamily: this.family, ...(this.bytes === undefined ? {} : { networkBytes: this.bytes }), historyAvailable: this.history, historyPartial: this.partial } : record);
      },
      lookup: record => sink.lookup(record),
    };
  }

  primary(): T { return this.begin('default', 'initial'); }

  get isAlternate(): boolean { return this.route !== 'default'; }

  get selectedRoute(): NonNullable<StepRecord['networkRoute']> { return this.route ?? 'default'; }

  /**
   * Choose once, only when an existing eligible retry actually starts. A named
   * route, chosen by the caller's allocation, takes the place of the lottery;
   * it must be one of the configured `routes`.
   */
  retry(choice?: AlternativeRoute): T {
    if (choice !== undefined) {
      const client = this.options.routes?.[choice];
      if (client === undefined || client === null) throw new TypeError('Unconfigured browser retry route');
      this.selected ??= choice;
    }
    this.selected ??= this.options.alternative !== null && Math.random() < this.options.share ? this.options.route : 'default';
    return this.begin(this.selected, 'retry');
  }

  private begin(route: 'default' | AlternativeRoute, attempt: 'initial' | 'retry'): T {
    this.pending = true; this.attempt = attempt; this.family = 'unknown'; this.bytes = undefined; this.history = false; this.partial = false;
    this.route = route;
    if (route === 'default') return this.options.primary;
    return (this.options.routes?.[route] ?? (route === this.options.route ? this.options.alternative : null))!;
  }

  observeFamily(family: 'IPv4' | 'IPv6' | 'unknown'): void { this.family = family; }

  observeBytes(bytes: unknown): void {
    if (typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0) this.bytes = bytes;
  }

  result(result: CarrierResult): CarrierResult {
    this.history = Boolean(result.events?.some(event => event.time || event.local_time));
    this.partial = result.history_truncated === true || result.summary_only === true;
    return result;
  }
}

export interface BrowserContextProxy { server: string; username?: string; password?: string }

/** Credentials are passed to a fresh browser context, never to a URL, diagnostic or metric. */
export function browserContextProxy(value: string): BrowserContextProxy {
  let url: URL | undefined;
  try { url = new URL(value.trim()); } catch { /* Use a fixed error without the configured value. */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || !url.hostname || !['', '/'].includes(url.pathname)
    || url.search || url.hash) throw new TypeError('Browser retry proxy must be an HTTP(S) origin');
  try {
    return { server: url.origin, ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}) };
  } catch { throw new TypeError('Browser retry proxy has invalid credentials'); }
}
