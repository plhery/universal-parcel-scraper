import type { Stage } from '../../core/status/index.js';

export const scanStages: ReadonlyMap<string, Stage> = new Map([
  ['created', 'registered'],
  ['Left US warehouse', 'in_transit'],
  ['Process US warehouse', 'accepted'],
  ['Вылетел из США Departed from original airport', 'in_transit'],
  ['Прибытие в страну Транзита Arrival at transit country', 'in_transit'],
  ['Прибыл в аеропорт вылета США Arrival to original airport', 'in_transit'],
  ['Убыло из транзитной страны Departed from transit country', 'in_transit'],
  ['Таможенное оформление Custom clearance', 'customs'],
  ['Прибыло в место международного обмена', 'in_transit'],
  ['Прибыло в сортировочный центр', 'in_transit'],
  ['Прибыло на территорию РФ', 'in_transit'],
  ['Выпущено таможней', 'in_transit'],
  ['Покинуло сортировочный центр', 'in_transit'],
  ['Сортировка', 'in_transit'],
  ['Покинуло место международного обмена', 'in_transit'],
  ['Прибыло в место вручения', 'in_transit'],
  ['Вручение адресату', 'delivered'],
]);

export const summaryStages: ReadonlyMap<string, Stage> = new Map([
  ['DELIVERED', 'delivered'],
  ['IN TRANSIT', 'in_transit'],
  ['OUT FOR DELIVERY', 'out_for_delivery'],
]);
