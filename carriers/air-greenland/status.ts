export const stageForActivity = {
  manifested: 'in_transit',
  arrived: 'in_transit',
  delivered_to_handler: 'in_transit',
  delivered: 'delivered',
} as const;

export type Activity = keyof typeof stageForActivity;
