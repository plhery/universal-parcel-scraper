import type { Stage } from '../../core/status/index.js';

const stages = new Map<string, Stage>([
  ['Carga Liberada', 'in_transit'],
  ['Consolidación Nacional', 'in_transit'],
  ['Creación Confirmada', 'registered'],
  ['Creación de Guia Confirmada', 'registered'],
  ['Creado', 'registered'],
  ['Disponible para retiro en Oficina', 'ready_for_pickup'],
  ['Disponible para retiro en Sede Engativa', 'ready_for_pickup'],
  ['En tránsito', 'in_transit'],
  ['Inspección Aduanera de Rutina', 'customs'],
  ['Proceso Aduanero', 'customs'],
  ['Recibido en Bodega de Tránsito Internacional', 'in_transit'],
  ['Salida de Origen', 'in_transit'],
  ['Tránsito Nacional e Internacional', 'in_transit'],
  ['Tránsito Nacional Venezuela', 'in_transit'],
]);

export function scanStage(wording: string): Stage | undefined {
  return stages.get(wording.normalize('NFC'));
}
