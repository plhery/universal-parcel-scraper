import type { Stage } from '../../core/status/index.js';

const wordings: readonly (readonly [RegExp, Stage])[] = [
  [/^快件在【[^】]+】被签收/, 'delivered'],
  [/^派件中【/, 'out_for_delivery'],
  [/^已收件/, 'accepted'],
  [/^(?:离开|到达)【/, 'in_transit'],
];

export function stageForWording(wording: string): Stage | undefined {
  return wordings.find(([pattern]) => pattern.test(wording))?.[1];
}
