import { hash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { BudgetExceededError, ChallengeError } from '../../core/errors/index.js';
import { isRecord } from '../../core/types.js';
import { PROVIDER } from './parser.js';

/** The proof of work KMTC's page solves before each search: a signed salt and the hash to find. */
export interface KmtcChallenge { salt: string; challenge: string; maxNumber: number; signature: string }

const HEX64 = /^[a-f0-9]{64}$/;

export function parseKmtcChallenge(value: unknown): KmtcChallenge {
  if (!isRecord(value) || typeof value.salt !== 'string' || !/^[\x21-\x2d\x2f-\x7e]{8,128}$/.test(value.salt)
    || typeof value.challenge !== 'string' || !HEX64.test(value.challenge)
    || typeof value.signature !== 'string' || !HEX64.test(value.signature)
    || !Number.isSafeInteger(value.maxNumber) || (value.maxNumber as number) < 1 || (value.maxNumber as number) > 1_000_000) {
    throw new ChallengeError(PROVIDER, 'KMTC changed its proof of work');
  }
  return { salt: value.salt, challenge: value.challenge, maxNumber: value.maxNumber as number, signature: value.signature };
}

/**
 * The page's answer: the number up to `maxNumber` whose SHA-256 after the salt is the challenge,
 * sent with the challenge as `salt.number.challenge.signature`.
 */
export async function solveKmtcChallenge(challenge: KmtcChallenge, signal: AbortSignal, deadline: number, budgetMs: number): Promise<string> {
  for (let number = 0; number <= challenge.maxNumber; number++) {
    if (number % 4096 === 0) {
      await nextTurn(); signal.throwIfAborted();
      if (performance.now() >= deadline) throw new BudgetExceededError(PROVIDER, budgetMs);
    }
    if (hash('sha256', `${challenge.salt}${number}`, 'hex') === challenge.challenge) {
      return `${challenge.salt}.${number}.${challenge.challenge}.${challenge.signature}`;
    }
  }
  throw new ChallengeError(PROVIDER, 'KMTC\'s proof of work has no answer');
}
