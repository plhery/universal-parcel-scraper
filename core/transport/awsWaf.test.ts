import { describe, expect, it } from 'vitest';
import { awsWafAction } from './awsWaf.js';

describe('awsWafAction', () => {
  it('reads the action from fetch headers, whatever their case', () => {
    expect(awsWafAction(new Headers({ 'X-Amzn-Waf-Action': 'challenge' }))).toBe('challenge');
    expect(awsWafAction(new Headers({ 'x-amzn-waf-action': 'captcha' }))).toBe('captcha');
  });

  it('reads the action from a capture', () => {
    expect(awsWafAction({ 'x-amzn-waf-action': 'challenge', 'content-type': 'text/html' })).toBe('challenge');
  });

  it('keeps an empty header apart from a missing one', () => {
    expect(awsWafAction(new Headers({ 'x-amzn-waf-action': '' }))).toBe('');
    expect(awsWafAction({ 'x-amzn-waf-action': '' })).toBe('');
    expect(awsWafAction(new Headers({ 'content-type': 'application/json' }))).toBeNull();
    expect(awsWafAction({})).toBeNull();
  });

  it('reads headers of another fetch library by their shape', () => {
    const foreign = { get: (name: string) => name === 'x-amzn-waf-action' ? 'challenge' : null };
    expect(awsWafAction(foreign)).toBe('challenge');
  });
});
