import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { askHuman, claimHolder, inbox, note, runDone, takeClaim, taskClaim, taskComment, taskCreate, taskState } from '../src/agent.ts';
import type { Company } from '../src/company.ts';
import { Daemon } from '../src/daemon.ts';
import { Plane } from '../src/plane.ts';
import { getSecret, secretsPath, setSecret } from '../src/secrets.ts';
import { loadState } from '../src/state.ts';
import { FakePlane } from './fake-plane.ts';
import { FakeHerdr, makeCompany, tmp } from './helpers.ts';

const fake = new FakePlane();
let company: Company;
let vault: string;

before(async () => {
  await fake.start();
  vault = tmp('fabrik-vault-');
  company = makeCompany({
    plane: { url: fake.url, workspace: 'acme', projects: ['ACME'], key_env: 'FAKE_PLANE_KEY', max_rpm: 1000 },
    obsidian: { vault, folder: 'Fabrik' },
  });
  setSecret(company, 'FAKE_PLANE_KEY', fake.key);
});
after(() => fake.stop());

const ada = () => company.agents.find((a) => a.slug === 'ada')!;
const cody = () => company.agents.find((a) => a.slug === 'cody')!;

function daemon(herdr: FakeHerdr): Daemon {
  const d = new Daemon(company);
  d.herdr = herdr as unknown as Daemon['herdr'];
  return d;
}

test('secrets are stored 0600 outside the company dir', () => {
  const path = secretsPath(company);
  assert.ok(!path.startsWith(company.root));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(getSecret(company, 'FAKE_PLANE_KEY'), fake.key);
});

test('plane client pages, maps labels/states and retries 429', async () => {
  for (let i = 0; i < 3; i++) fake.addIssue(`paging ${i}`);
  const plane = new Plane(company.config.plane!, fake.key);
  fake.rateLimitNext = 1;
  const all = await plane.issuesUpdatedSince('ACME', null);
  assert.equal(all.length, fake.issues.length);
  assert.equal(all[0]!.stateGroup, 'unstarted');
  const newest = all[0]!.updatedAt;
  assert.equal((await plane.issuesUpdatedSince('ACME', newest)).length, 1, 'stops at the high-water mark');
  const one = await plane.issue(all[0]!.key);
  assert.equal(one.id, all[0]!.id);
  assert.equal((await plane.stateFor(one.projectId, 'in_review')).name, 'In Review');
});

test('claims are exclusive', () => {
  assert.equal(takeClaim(company, 'ACME-99', 'ada'), true);
  assert.equal(takeClaim(company, 'ACME-99', 'ada'), true, 're-claiming your own ticket is fine');
  assert.equal(takeClaim(company, 'ACME-99', 'cody'), false);
  assert.equal(claimHolder(company, 'acme-99'), 'ada');
});

test('agent task flow against Plane', async () => {
  const issue = fake.addIssue('Build the landing page', { labels: ['agent:cody'] });
  const key = `ACME-${issue.sequence_id}`;
  assert.match(await inbox(company, cody()), new RegExp(`${key}\\s+Todo\\s+Build the landing page`));
  assert.match(await taskClaim(company, cody(), key), /claimed .* \(In Progress\)/);
  await assert.rejects(taskClaim(company, ada(), key), /claimed by cody/);
  await taskComment(company, cody(), key, 'Scaffolded the page.\n\nNext: copy.');
  const posted = fake.comments.filter((c) => c.issue === issue.id).at(-1)!;
  assert.match(posted.comment_html, /<code>fabrik:cody<\/code>/);
  assert.match(await taskState(company, cody(), key, 'done'), /-> Done/);
  assert.equal(claimHolder(company, key), null, 'done releases the claim');

  const sub = await taskCreate(company, ada(), 'Write copy', { assign: 'cody', parent: key, body: 'Short and punchy' });
  const created = fake.issues.at(-1)!;
  assert.match(sub, /created ACME-\d+ for cody/);
  assert.equal(created.parent, issue.id);
  assert.deepEqual(created.labels, [fake.label('agent:cody')]);
});

test('ask-human creates a human ticket, registers the requester and writes attention.md', async () => {
  const r = await askHuman(company, cody(), 'May I buy a domain for 12 EUR?');
  assert.match(r, /asked the human in ACME-\d+/);
  const q = fake.issues.at(-1)!;
  assert.deepEqual(q.labels, [fake.label('human')]);
  assert.equal(loadState(company).plane.askHuman[q.id], 'cody');
  assert.match(readFileSync(join(vault, 'Fabrik', 'attention.md'), 'utf8'), /cody asks: May I buy a domain/);
});

test('journal notes and run reports', () => {
  assert.match(note(company, ada(), 'Decided to ship Friday'), /journal\/ada\//);
  runDone(company, ada(), 'Planned the week');
  const journal = readFileSync(join(vault, 'Fabrik', 'journal', 'ada', `${new Date().toISOString().slice(0, 10)}.md`), 'utf8');
  assert.match(journal, /Decided to ship Friday[\s\S]*run done: Planned the week/);
});

test('daemon: bootstrap is silent, then a label wakes the agent exactly once', async () => {
  const herdr = new FakeHerdr();
  const adaLive = herdr.addAgent('ada');
  const codyLive = herdr.addAgent('cody');
  const d = daemon(herdr);

  await d.tick();
  assert.equal(herdr.prompts.length, 0, 'first poll only snapshots Plane');
  assert.equal(herdr.metadata.length, 2, 'metadata re-applied on first contact');

  const issue = fake.addIssue('Fix the footer');
  await forcePoll(d);
  assert.equal(herdr.prompts.length, 1, 'new unassigned ticket goes to the router (ada)');
  assert.equal(herdr.prompts[0]!.name, 'ada');
  assert.match(herdr.prompts[0]!.text, new RegExp(`ACME-${issue.sequence_id}: new unassigned ticket`));

  // ada is now in a run; finishing it requires working -> idle with a newer completion_seq.
  adaLive.agent_status = 'working';
  await d.tick();
  adaLive.agent_status = 'idle';
  adaLive.completion_seq = 2;
  runDone(company, ada(), 'triaged');
  await d.tick();
  assert.equal(loadState(company).agents.ada!.inflight, null);
  assert.equal(loadState(company).agents.ada!.failures, 0);

  fake.setLabels(issue, ['agent:cody']);
  codyLive.agent_status = 'working'; // busy: must queue, not type into the running turn
  await forcePoll(d);
  assert.equal(herdr.prompts.filter((p) => p.name === 'cody').length, 0);
  assert.deepEqual(loadState(company).agents.cody!.queue.map((q) => q.key), [`ACME-${issue.sequence_id}`]);

  codyLive.agent_status = 'idle';
  await d.tick();
  await d.tick();
  const codyPrompts = herdr.prompts.filter((p) => p.name === 'cody');
  assert.equal(codyPrompts.length, 1, 'delivered once when idle');
  assert.match(codyPrompts[0]!.text, /assigned/);
  assert.ok(existsSync(join(vault, 'Fabrik', 'agents', 'cody.md')));
});

test('daemon: dialogs are dismissed before waking, caps and pause hold wakes', async () => {
  const herdr = new FakeHerdr();
  herdr.addAgent('ada');
  herdr.addAgent('cody');
  const d = daemon(herdr);
  await d.tick();
  // Clear any leftover run from the previous test.
  await import('../src/state.ts').then(({ withState }) => withState(company, (s) => { for (const a of Object.values(s.agents)) { a.inflight = null; a.queue = []; a.paused = false; a.runsToday = 0; } }));

  herdr.screens.ada = 'Teach auto mode about your environment? 1. Yes 2. Not now';
  wake('ada');
  await d.tick();
  assert.deepEqual(herdr.keys, [{ name: 'ada', keys: ['esc'] }]);
  assert.equal(herdr.prompts.length, 0, 'no prompt while a popup is up');
  await d.tick();
  assert.equal(herdr.prompts.length, 1);

  await import('../src/state.ts').then(({ withState }) => withState(company, (s) => { s.agents.cody!.paused = true; }));
  wake('cody');
  await d.tick();
  assert.equal(herdr.prompts.filter((p) => p.name === 'cody').length, 0, 'paused agents are not woken');
});

test('daemon: inbox notes wake their addressee once per edit', async () => {
  const herdr = new FakeHerdr();
  herdr.addAgent('ada');
  const live = herdr.addAgent('cody');
  const d = daemon(herdr);
  await import('../src/state.ts').then(({ withState }) => withState(company, (s) => { for (const a of Object.values(s.agents)) { a.inflight = null; a.queue = []; a.paused = false; a.runsToday = 0; } }));
  mkdirSync(join(vault, 'Fabrik', 'inbox'), { recursive: true });
  writeFileSync(join(vault, 'Fabrik', 'inbox', 'idea.md'), '---\nto: cody\n---\nPlease look at the pricing page.\n');
  await d.tick();
  await d.tick();
  assert.equal(herdr.prompts.filter((p) => p.name === 'cody' && /note:inbox\/idea.md/.test(p.text)).length, 1);
  live.agent_status = 'idle';
});

function wake(agent: string): void {
  const dir = join(company.stateDir, 'wake');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${Date.now()}-${Math.random()}.json`), JSON.stringify({ agent, key: 'manual', reason: 'test' }));
}

async function forcePoll(d: Daemon): Promise<void> {
  await import('../src/state.ts').then(({ withState }) => withState(company, (s) => { s.plane.lastPoll = 0; }));
  await d.tick();
}
