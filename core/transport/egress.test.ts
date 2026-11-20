import { describe, expect, it } from 'vitest';
import { EgressPacer, egressesOf } from './egress.js';
import { proxyEgressPool } from './proxyEgress.js';
import { sendsThrough } from './transportOf.js';

const send = (): typeof fetch => async () => new Response('');

describe('EgressPacer', () => {
  it('uses the host fetcher first, then the pool egress that rested longest, and fails as self-paced when none has a turn', () => {
    const pacer = new EgressPacer('Carrier', { reads: 2, windowMs: 60_000, pauseMs: 30_000 });
    const own = send();
    const pool = [{ id: 'dc-1', fetcher: send() }, { id: 'dc-2', fetcher: send() }];
    const egresses = egressesOf(own, pool);
    expect([pacer.take(egresses, 0).id, pacer.take(egresses, 1).id]).toEqual(['default', 'default']);
    expect(pacer.take(egresses, 2).id).toBe('dc-1');
    expect(pacer.take(egresses, 3).id).toBe('dc-2');
    expect(pacer.take(egresses, 4).id).toBe('dc-1');
    expect(pacer.take(egresses, 5).id).toBe('dc-2');
    expect(() => pacer.take(egresses, 6)).toThrow(expect.objectContaining({ kind: 'rate_limited', retryAfterMs: 59_994, reason: 'self_paced' }));
    expect(pacer.take(egresses, 60_000).id).toBe('default');
  });

  it('rests a refused egress for the wait the carrier named, else for its pause', () => {
    const pacer = new EgressPacer('Carrier', { reads: 5, windowMs: 60_000, pauseMs: 30_000 });
    const [own] = egressesOf(undefined, undefined);
    expect(pacer.refused(own!, undefined, 0)).toBe(30_000);
    expect(pacer.waitMs([own!], 10_000)).toBe(20_000);
    expect(pacer.refused(own!, 90_000, 10_000)).toBe(90_000);
    expect(pacer.waitMs([own!], 10_000)).toBe(90_000);
    expect(pacer.refused(own!, 0, 100_000)).toBe(0);
    expect(pacer.take([own!], 100_000).id).toBe('default');
  });

  it('shares turns between the wrappers of one transport', () => {
    const pacer = new EgressPacer('Carrier', { reads: 1, windowMs: 60_000, pauseMs: 0 });
    const transport = send();
    pacer.take(egressesOf(sendsThrough(send(), transport), undefined), 0);
    expect(() => pacer.take(egressesOf(sendsThrough(send(), transport), undefined), 1)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(pacer.take(egressesOf(send(), undefined), 1).id).toBe('default');
  });
});

describe('proxyEgressPool', () => {
  it('makes one labelled egress per proxy URL without naming addresses or credentials', async () => {
    const seen: unknown[] = [];
    const pool = proxyEgressPool('http://user:secret@192.0.2.1:8000, http://192.0.2.2:8000\nhttps://192.0.2.3:443', 'datacenter',
      async (_input, init) => { seen.push((init as { dispatcher?: unknown }).dispatcher); return new Response(''); });
    expect(pool.map(egress => egress.id)).toEqual(['datacenter-1', 'datacenter-2', 'datacenter-3']);
    await pool[0]!.fetcher('https://example.test/');
    expect(seen[0]).toBeDefined();
    expect(proxyEgressPool(undefined)).toEqual([]);
    expect(() => proxyEgressPool('socks5://192.0.2.1:1080', 'datacenter')).toThrow('datacenter egress 1 must be an HTTP proxy URL');
  });
});
