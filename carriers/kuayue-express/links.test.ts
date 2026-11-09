import { describe, expect, it } from 'vitest';
import { parseTrackingInput } from '../../core/detection/index.js';

describe('Kuayue official guest links', () => {
  const number = 'KY7312064859017';
  it('reads the current website path and retained legacy alias on the official host', () => {
    for (const path of ['/88.html', '/website/88.html']) {
      expect(parseTrackingInput(`https://www.ky-express.com${path}?tab=3&orders=${number}`)).toMatchObject({ carrier: 'kuayue-express', trackingNumber: number, source: 'link' });
    }
    expect(parseTrackingInput(`https://unrelated.invalid/website/88.html?orders=7312064859017`).carrier).not.toBe('kuayue-express');
  });
});
