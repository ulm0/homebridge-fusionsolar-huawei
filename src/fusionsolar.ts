export interface FusionSolarDeviceTips {
  SOC?: number;
  CHARGE_CAPACITY?: number;
  DISCHARGE_CAPACITY?: number;
  BATTERY_POWER?: number;
}

export interface FusionSolarFlowNode {
  mocId: string | number;
  value?: number;
  deviceTips?: FusionSolarDeviceTips;
}

export interface FusionSolarSnapshot {
  currentProduction: number;
  batteryPower: number;
  generalConsumption: number;
  gridImport: number;
  gridExport: number;
  batterySoc: number;
  batteryChargeCapacity: number;
  batteryDischargeCapacity: number;
  batteryPowerFromTips: number;
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function computeGridBalance(
  currentProduction: number,
  batteryPower: number,
  generalConsumption: number,
): { gridImport: number; gridExport: number } {
  const balance = generalConsumption - (currentProduction + batteryPower);
  if (balance > 0) {
    return { gridImport: balance, gridExport: 0 };
  }
  return { gridImport: 0, gridExport: Math.abs(balance) };
}

export function createSnapshotFromFlowNodes(nodes: FusionSolarFlowNode[]): FusionSolarSnapshot {
  const currentProduction = asFiniteNumber(nodes[0]?.value);
  const batteryPower = asFiniteNumber(nodes[4]?.value);
  const generalConsumption = asFiniteNumber(nodes[5]?.value);
  const { gridImport, gridExport } = computeGridBalance(currentProduction, batteryPower, generalConsumption);

  return {
    currentProduction,
    batteryPower,
    generalConsumption,
    gridImport,
    gridExport,
    batterySoc: asFiniteNumber(nodes[4]?.deviceTips?.SOC),
    batteryChargeCapacity: asFiniteNumber(nodes[4]?.deviceTips?.CHARGE_CAPACITY),
    batteryDischargeCapacity: asFiniteNumber(nodes[4]?.deviceTips?.DISCHARGE_CAPACITY),
    batteryPowerFromTips: asFiniteNumber(nodes[4]?.deviceTips?.BATTERY_POWER),
  };
}

export function findFlowNodes(payload: unknown): FusionSolarFlowNode[] | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const maxDepth = 7;
  const queue: Array<{ value: unknown; depth: number }> = [{ value: payload, depth: 0 }];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const { value, depth } = current;

    if (!value || typeof value !== 'object' || visited.has(value)) {
      continue;
    }
    visited.add(value);

    const candidate = value as { flow?: { nodes?: unknown } };
    if (Array.isArray(candidate.flow?.nodes) && candidate.flow.nodes.length >= 6) {
      const nodes = candidate.flow.nodes as FusionSolarFlowNode[];
      if (nodes[0]?.mocId != null && nodes[4]?.deviceTips != null) {
        return nodes;
      }
    }

    if (depth >= maxDepth) {
      continue;
    }

    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child && typeof child === 'object') {
        queue.push({ value: child, depth: depth + 1 });
      }
    }
  }

  return null;
}
