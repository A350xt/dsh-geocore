/** 桥契约测试：直连真实 Python 内核，验证 node 侧收发的封套与产物。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SYNTH = path.join(REPO, 'datasets', 'synthetic');

if (!existsSync(path.join(SYNTH, 'ground_truth.json'))) {
  console.warn(
    `[skip] 未找到合成数据。请先运行：python ${REPO}/scripts/make_synthetic_data.py`,
  );
}

let bridge!: import('../src/bridge.js').PythonBridge;

test.before(async () => {
  const { PythonBridge } = await import('../src/bridge.js');
  bridge = new PythonBridge({
    pythonCmd: process.env.GEOCORE_PYTHON ?? 'python',
    workdir: mkdtempSync(path.join(tmpdir(), 'geocore-node-')),
    timeoutMs: 120_000,
  });
});

test('inspect 返回结构化描述', { skip: !existsSync(path.join(SYNTH, 'ground_truth.json')) },
  async () => {
    const res = await bridge.call('inspect', { path: path.join(SYNTH, 'hospitals.geojson') });
    assert.equal(res.count, 12);
    assert.equal(res.crs, 'EPSG:4326');
    assert.ok((res.fields as any[]).some((f) => f.name === 'beds'));
  });

test('analyze 链式步骤产出 artifact 与中文摘要',
  { skip: !existsSync(path.join(SYNTH, 'ground_truth.json')) },
  async () => {
    const res: any = await bridge.call('analyze', {
      title: 'node 契约冒烟',
      operations: [
        { id: 'f', op: 'query.filter',
          input: path.join(SYNTH, 'roads.geojson'), where: "`class` == '高速'" },
        { id: 'm', op: 'query.measure', input: '@f', measures: ['length_km'] },
      ],
    });
    assert.ok(String(res.artifact_id).startsWith('ar_'));
    assert.equal(res.steps.length, 2);
    assert.match(res.summary.join(''), /总长度/);
  });

test('未知操作映射为 E_OP_UNKNOWN 并附词表', async () => {
  await assert.rejects(
    () => bridge.call('analyze', { operations: [{ id: 'x', op: 'nope.thing' }] }),
    (err: any) => {
      assert.equal(err.code, 'E_OP_UNKNOWN');
      assert.ok(Array.isArray(err.details.available));
      return true;
    },
  );
});

test('空结果默认报错并提示 allow_empty',
  { skip: !existsSync(path.join(SYNTH, 'ground_truth.json')) },
  async () => {
    await assert.rejects(
      () => bridge.call('analyze', {
        operations: [{ id: 'e', op: 'query.filter',
                       input: path.join(SYNTH, 'parcels.geojson'),
                       where: 'pop_density > 99999999' }],
      }),
      (err: any) => err.code === 'E_EMPTY_RESULT' && err.message.includes('allow_empty'),
    );
  });
