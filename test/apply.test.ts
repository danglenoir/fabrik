import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { apply } from '../src/apply.ts';
import { loadCompany } from '../src/company.ts';
import { Daemon } from '../src/daemon.ts';
import { setAgentFields } from '../src/edit.ts';
import type { Herdr } from '../src/herdr.ts';
import { loadState, withState } from '../src/state.ts';
import { FakeHerdr, makeCompany } from './helpers.ts';

const run = (company: ReturnType<typeof makeCompany>, herdr: FakeHerdr, opts: Parameters<typeof apply>[1] = {}) =>
  apply(company, { ...opts, herdr: herdr as unknown as Herdr });

test('a dry run reports what it would start and starts nothing', async () => {
  const company = makeCompany();
  const herdr = new FakeHerdr();
  const r = await run(company, herdr, { dryRun: true });
  assert.deepEqual(r.wouldStart, ['ada', 'cody']);
  assert.deepEqual(r.started, []);
  assert.deepEqual(herdr.started, []);
  assert.equal(herdr.workspaceList.length, 0);
});

test('apply starts and introduces every agent once, and a rerun changes nothing', async () => {
  const company = makeCompany();
  const herdr = new FakeHerdr();
  herdr.workOnPrompt = true;
  const r = await run(company, herdr);
  assert.deepEqual(r.started, ['ada', 'cody']);
  assert.deepEqual(r.introduced, ['ada', 'cody']);
  assert.deepEqual(herdr.tabList.map((t) => t.label), ['board', 'ada · ceo', 'cody · engineer']);
  assert.equal(loadState(company).agents.cody!.introduced, true);
  assert.match(herdr.shellLines[0]!.command, /^ export FABRIK_AGENT='ada' FABRIK_COMPANY_DIR='[^']+'/, 'variables exported before the harness starts');

  for (const a of herdr.live) a.agent_status = 'idle';
  const again = await run(company, herdr);
  assert.deepEqual(again.existing, ['ada', 'cody']);
  assert.deepEqual(again.started, []);
  assert.equal(herdr.prompts.length, 2, 'no second introduction');
});

test('a swallowed introduction is retried, and reported when it never arrives', async () => {
  const company = makeCompany();
  const herdr = new FakeHerdr();
  herdr.workOnPrompt = true;
  herdr.swallow = { ada: 1, cody: 2 };
  const r = await run(company, herdr);
  assert.deepEqual(r.introduced, ['ada']);
  assert.equal(herdr.prompts.filter((p) => p.name === 'ada').length, 2);
  assert.match(r.needsAttention.find((n) => n.agent === 'cody')?.reason ?? '', /did not pick up its introduction/);
  assert.equal(loadState(company).agents.cody!.introduced, false, 'the next apply tries again');
});

test('a codex update prompt at startup is dismissed and the agent gets its name back', async () => {
  const company = makeCompany();
  const herdr = new FakeHerdr();
  herdr.workOnPrompt = true;
  herdr.startPopup = { cody: 'Update available 0.162.1 -> 0.163.0\n1. Update now\n2. Skip\n3. Skip until next version' };
  const r = await run(company, herdr);
  assert.deepEqual(r.needsAttention, []);
  assert.deepEqual(r.started, ['ada', 'cody']);
  const codyPane = loadState(company).agents.cody!.paneId!;
  assert.deepEqual(herdr.keys, [{ name: codyPane, keys: ['down', 'enter'] }]);
  assert.deepEqual(herdr.renames, [{ target: codyPane, name: 'cody' }]);
  assert.ok(r.introduced.includes('cody'));
});

test('an unknown startup prompt is quoted back to the human', async () => {
  const company = makeCompany();
  const herdr = new FakeHerdr();
  herdr.startPopup = { cody: 'Choose a colour theme\n> Dark' };
  const r = await run(company, herdr);
  assert.match(r.needsAttention.find((n) => n.agent === 'cody')?.reason ?? '', /blocked during startup \("> Dark"\)/);
});

test('apply adopts an unnamed agent in the pane it last used', async () => {
  const company = makeCompany();
  const herdr = new FakeHerdr();
  const unnamed = herdr.addAgent('cody', 'idle', 'codex');
  unnamed.name = null;
  herdr.addAgent('ada');
  await withState(company, (s) => { s.agents.cody!.paneId = unnamed.pane_id; s.agents.cody!.introduced = true; s.agents.ada!.introduced = true; });
  const r = await run(company, herdr);
  assert.deepEqual(r.existing, ['ada', 'cody']);
  assert.deepEqual(herdr.started, [], 'no second codex in the same pane');
  assert.deepEqual(herdr.renames, [{ target: unnamed.pane_id, name: 'cody' }]);
});

test('new launch settings restart idle agents; busy agents keep running until idle', async () => {
  const company = makeCompany();
  const herdr = new FakeHerdr();
  herdr.workOnPrompt = true;
  await run(company, herdr);
  for (const a of herdr.live) a.agent_status = 'idle';

  setAgentFields(company, 'cody', { model: 'gpt-6-sol' });
  herdr.find('ada')!.agent_status = 'working';
  setAgentFields(company, 'ada', { effort: 'high' });
  const r = await run(loadCompany(company.root), herdr);
  assert.deepEqual(r.restarted, ['cody']);
  assert.ok(r.existing.includes('ada'), 'ada is busy: restarted later');
  assert.equal(herdr.prompts.filter((p) => p.name === 'cody' && p.text === '/exit').length, 1);
  assert.deepEqual(herdr.started, ['ada', 'cody', 'cody']);
  assert.ok(loadState(company).agents.cody!.launchSig!.includes('gpt-6-sol'));
});

test('switching an agent off quits its harness once idle', async () => {
  const company = makeCompany();
  const herdr = new FakeHerdr();
  herdr.workOnPrompt = true;
  await run(company, herdr);
  for (const a of herdr.live) a.agent_status = 'idle';
  setAgentFields(company, 'cody', { enabled: false });
  const r = await run(loadCompany(company.root), herdr);
  assert.deepEqual(r.stopped, ['cody']);
  assert.equal(herdr.find('cody'), undefined);
});

test('the daemon rolls a settings change through idle agents', async () => {
  const company = makeCompany();
  const herdr = new FakeHerdr();
  herdr.workOnPrompt = true;
  await run(company, herdr);
  for (const a of herdr.live) a.agent_status = 'idle';
  const d = new Daemon(company);
  d.herdr = herdr as unknown as Daemon['herdr'];
  await d.tick();
  assert.deepEqual(herdr.started, ['ada', 'cody'], 'nothing changed, nothing restarted');

  setAgentFields(company, 'ada', { model: 'sonnet' });
  setAgentFields(company, 'cody', { model: 'gpt-6-sol' });
  await d.tick();
  await d.tick();
  assert.deepEqual(herdr.started, ['ada', 'cody', 'ada', 'cody'], 'one restart per tick, both done after two');
});
