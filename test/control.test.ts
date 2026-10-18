import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONTINUE_REASON, pauseAgent, stopAgent } from '../src/control.ts';
import type { Herdr } from '../src/herdr.ts';
import { loadState, withState } from '../src/state.ts';
import { FakeHerdr, makeCompany } from './helpers.ts';

test('stop interrupts a working agent, pauses it and keeps its work first in the queue', async () => {
  const company = makeCompany();
  const herdr = new FakeHerdr();
  herdr.addAgent('ada');
  herdr.addAgent('cody', 'working', 'codex');
  await withState(company, (s) => {
    s.agents.cody!.inflight = { runId: 'R1', seqBefore: 1, startedAt: Date.now() - 5000, items: [{ key: 'ACME-2', reasons: ['assigned'], firstAt: 0, lastAt: 0 }], sawWorking: true, escalated: false };
    s.agents.cody!.queue = [{ key: 'ACME-2', reasons: ['comment from a human'], firstAt: 1, lastAt: 1 }, { key: 'ACME-5', reasons: ['assigned'], firstAt: 1, lastAt: 1 }];
  });

  const msg = await stopAgent(company, 'cody', herdr as unknown as Herdr);
  assert.match(msg, /cody interrupted and paused; ACME-2 stays queued/);
  assert.deepEqual(herdr.keys, [{ name: 'cody', keys: ['esc'] }]);
  const s = loadState(company).agents.cody!;
  assert.equal(s.paused, true);
  assert.equal(s.inflight, null);
  assert.deepEqual(s.queue.map((q) => q.key), ['ACME-2', 'ACME-5']);
  assert.deepEqual(s.queue[0]!.reasons, ['assigned', CONTINUE_REASON, 'comment from a human']);
  assert.match(readFileSync(join(company.stateDir, 'runs.jsonl'), 'utf8'), /"outcome":"stopped"/);
});

test('stopping an idle agent only pauses it; resume reports the queue', async () => {
  const company = makeCompany();
  const herdr = new FakeHerdr();
  herdr.addAgent('ada');
  assert.match(await stopAgent(company, 'ada', herdr as unknown as Herdr), /^ada paused\./);
  assert.deepEqual(herdr.keys, [], 'nothing typed into an idle agent');
  await withState(company, (s) => { s.agents.ada!.queue = [{ key: 'ACME-1', reasons: ['assigned'], firstAt: 0, lastAt: 0 }]; s.agents.ada!.failures = 2; });
  assert.match(await pauseAgent(company, 'ada', false), /ada resumed; 1 queued item will be delivered/);
  assert.equal(loadState(company).agents.ada!.failures, 0);
  await assert.rejects(stopAgent(company, 'nobody', herdr as unknown as Herdr), /no agent "nobody"/);
});
