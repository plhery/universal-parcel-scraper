import { hash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { BudgetExceededError, ChallengeError, IndeterminateError } from '../../core/errors/index.js';
import { isRecord } from '../../core/types.js';
import { PROVIDER } from './parser.js';

export interface HonducorChallenge {
  parameters: { algorithm: 'SHA-256'; cost: number; keyLength: 32; keyPrefix: string; nonce: string; salt: string; expiresAt: number };
  signature: string;
}

export function parseHonducorChallenge(value: unknown): HonducorChallenge {
  const invalid = () => new ChallengeError(PROVIDER, 'Honducor changed its proof-of-work challenge');
  if (!isRecord(value) || Object.keys(value).length !== 2 || !isRecord(value.parameters)
    || typeof value.signature !== 'string' || value.signature.length < 16 || value.signature.length > 2048 || /[^\x21-\x7e]/.test(value.signature)) throw invalid();
  const p = value.parameters;
  const keys = ['algorithm', 'cost', 'keyLength', 'keyPrefix', 'nonce', 'salt', 'expiresAt'];
  if (Object.keys(p).length !== keys.length || !keys.every(key => Object.hasOwn(p, key))
    || p.algorithm !== 'SHA-256' || !Number.isSafeInteger(p.cost) || (p.cost as number) < 1 || (p.cost as number) > 40_000
    || p.keyLength !== 32 || typeof p.keyPrefix !== 'string' || !/^[a-f0-9]{1,2}$/i.test(p.keyPrefix)
    || typeof p.nonce !== 'string' || !/^[a-f0-9]{32}$/i.test(p.nonce)
    || typeof p.salt !== 'string' || !/^[a-f0-9]{32}$/i.test(p.salt)
    || !Number.isSafeInteger(p.expiresAt) || (p.expiresAt as number) * 1000 <= Date.now() + 2000) throw invalid();
  return value as unknown as HonducorChallenge;
}

/** The widget's v2 SHA worker: salt || nonce || uint32-BE counter, iterated `cost` times. */
export async function solveHonducorChallenge(challenge: HonducorChallenge, signal: AbortSignal, deadline: number, budgetMs: number): Promise<string> {
  const { parameters } = challenge;
  const prefix = parameters.keyPrefix.toLowerCase();
  const input = Buffer.alloc(36);
  Buffer.from(parameters.salt, 'hex').copy(input, 0);
  Buffer.from(parameters.nonce, 'hex').copy(input, 16);
  const started = performance.now();
  let hashes = 0;
  try {
    for (let counter = 0; hashes + parameters.cost <= 32_000_000; counter++) {
      signal.throwIfAborted();
      input.writeUInt32BE(counter, 32);
      let derived = input;
      for (let iteration = 0; iteration < parameters.cost; iteration++) {
        if (hashes % 4096 === 0) {
          await nextTurn(); signal.throwIfAborted();
          if (performance.now() >= deadline) throw new BudgetExceededError(PROVIDER, budgetMs);
          if (parameters.expiresAt * 1000 <= Date.now() + 1000) throw new ChallengeError(PROVIDER, 'Honducor security check expired');
        }
        derived = hash('sha256', derived, 'buffer'); hashes++;
      }
      const key = derived.toString('hex');
      if (key.startsWith(prefix)) {
        const time = Math.floor((performance.now() - started) * 10) / 10;
        return Buffer.from(JSON.stringify({ challenge: { parameters, signature: challenge.signature },
          solution: { counter, derivedKey: key, time } })).toString('base64');
      }
    }
    throw new IndeterminateError(PROVIDER, 'Honducor asked for more proof of work than a lookup can spend', { reason: 'costly_puzzle' });
  } finally { input.fill(0); }
}
