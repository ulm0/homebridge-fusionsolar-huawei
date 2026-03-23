import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeGridBalance,
  createSnapshotFromFlowNodes,
  findFlowNodes,
} from '../dist/fusionsolar.js';

test('computeGridBalance returns import when load is higher', () => {
  const result = computeGridBalance(1000, 500, 2000);
  assert.deepEqual(result, { gridImport: 500, gridExport: 0 });
});

test('computeGridBalance returns export when generation is higher', () => {
  const result = computeGridBalance(3000, 500, 2000);
  assert.deepEqual(result, { gridImport: 0, gridExport: 1500 });
});

test('findFlowNodes finds nested flow payload', () => {
  const payload = {
    data: {
      widget: {
        flow: {
          nodes: [
            { mocId: 'pv', value: 4500 },
            {},
            {},
            {},
            { mocId: 'battery', value: -400, deviceTips: { SOC: 65 } },
            { mocId: 'house', value: 2600 },
          ],
        },
      },
    },
  };

  const nodes = findFlowNodes(payload);
  assert.ok(nodes);
  assert.equal(nodes[0].mocId, 'pv');
});

test('createSnapshotFromFlowNodes maps expected values', () => {
  const snapshot = createSnapshotFromFlowNodes([
    { mocId: 'pv', value: 4000 },
    {},
    {},
    {},
    {
      mocId: 'battery',
      value: -300,
      deviceTips: {
        SOC: 77,
        CHARGE_CAPACITY: 3.2,
        DISCHARGE_CAPACITY: 2.7,
        BATTERY_POWER: -300,
      },
    },
    { mocId: 'house', value: 2500 },
  ]);

  assert.equal(snapshot.currentProduction, 4000);
  assert.equal(snapshot.gridExport, 1200);
  assert.equal(snapshot.batterySoc, 77);
  assert.equal(snapshot.batteryPowerFromTips, -300);
});
