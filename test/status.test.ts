import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renderCompact, renderTable } from '../src/status.ts';
import type { CompanyStatus } from '../src/status.ts';

const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');

const status: CompanyStatus = {
  name: 'Fabrik Test', slug: 'fabtest', root: '/home/u/fabrik/fabtest', daemon: 4242, herdrError: null,
  agents: [
    { slug: 'ada', title: 'CEO', status: 'idle', runsToday: 1, queue: [] },
    { slug: 'cody', title: 'Engineer', status: 'working', runsToday: 3, queue: ['FAB-2'] },
    { slug: 'wren', title: 'Ops', status: 'paused', runsToday: 0, queue: ['FAB-7', 'FAB-9'] },
  ],
};

test('the popup is one line per agent and fits its width', () => {
  const lines = renderCompact([status], 60, 14).map(plain);
  assert.match(lines[0]!, /^Fabrik Test +daemon running$/);
  assert.match(lines[1]!, /^ada {3}CEO {7}idle {6}1 run {5}-/);
  assert.match(lines[2]!, /^cody  Engineer  working   3 runs    FAB-2/);
  assert.match(lines.at(-1)!, /q close/);
  for (const l of lines) assert.ok(l.length <= 60, `"${l}" is wider than the popup`);
});

test('the popup uses palette colours only, never RGB', () => {
  const raw = renderCompact([status], 60, 14).join('\n');
  assert.doesNotMatch(raw, /\u001b\[(38|48);[25];/);
  assert.match(raw, /\u001b\[32mworking/);
});

test('the popup shortens long companies to its height', () => {
  const many = { ...status, agents: Array.from({ length: 20 }, (_, i) => ({ slug: `a${i}`, title: 'Agent', status: 'idle', runsToday: 0, queue: [] })) };
  const lines = renderCompact([many], 60, 10).map(plain);
  assert.equal(lines.length, 10);
  assert.match(lines.at(-3)!, /more lines; run fabrik status/);
});

test('fabrik status keeps its plain table', () => {
  assert.match(renderTable(status), /^Fabrik Test — \/home\/u\/fabrik\/fabtest\ndaemon: running \(pid 4242\)/);
});
