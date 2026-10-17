import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { agentForCwd, loadCompany, renderOrg } from '../src/company.ts';
import { ADAPTERS } from '../src/harness.ts';
import { initCompany } from '../src/init.ts';
import { parseDuration } from '../src/util.ts';
import { makeCompany, proposal, tmp } from './helpers.ts';

test('init writes a company that loads back', () => {
  const c = makeCompany();
  assert.equal(c.agents.length, 2);
  for (const f of ['fabrik.yaml', 'COMPANY.md', 'AGENTS.md', 'CLAUDE.md', 'ORG.md', 'PROPOSAL.md', 'agents/ada/AGENTS.md', 'agents/ada/CLAUDE.md']) {
    assert.ok(existsSync(join(c.root, f)), f);
  }
  assert.equal(readFileSync(join(c.root, 'CLAUDE.md'), 'utf8'), readFileSync(join(c.root, 'AGENTS.md'), 'utf8'), 'root CLAUDE.md is a copy, never an external import');
  assert.equal(readFileSync(join(c.root, 'agents', 'ada', 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  const ada = c.agents.find((a) => a.slug === 'ada')!;
  assert.equal(ada.reportsTo, null);
  assert.match(ada.instructions, /You are Ada, the CEO/);
  assert.equal(loadCompany(join(c.root, 'agents', 'cody')).root, c.root);
  assert.match(readFileSync(join(c.root, 'COMPANY.md'), 'utf8'), /## Mission\n\nShip things/);
});

test('agent identity comes from the working directory', () => {
  const c = makeCompany();
  assert.equal(agentForCwd(c, join(c.root, 'agents', 'cody', 'src'))?.slug, 'cody');
  assert.equal(agentForCwd(c, c.root), null);
});

test('org validation rejects bad structures', () => {
  const bad = (agents: unknown[], re: RegExp) => {
    const dir = tmp();
    writeFileSync(join(dir, 'p.yaml'), stringify(proposal({ agents, router: {} })));
    assert.throws(() => initCompany({ proposalPath: join(dir, 'p.yaml'), dir: join(dir, 'x'), git: false }), re);
  };
  const a = (slug: string, reports_to: string | null, extra = {}) => ({ slug, name: slug, title: 'T', reports_to, harness: 'claude', model: 'haiku', ...extra });
  bad([a('ada', null), a('bob', null)], /exactly one top agent/);
  bad([a('ada', null), a('bob', 'zed')], /unknown agent zed/);
  bad([a('Ada', null)], /must match/);
  bad([a('ada', null, { harness: 'gemini' })], /unknown harness/);
  bad([a('ada', 'bob'), a('bob', 'ada'), a('root', null)], /reporting loop/);
});

test('init refuses the home directory and existing companies', () => {
  const c = makeCompany();
  const p = join(c.root, '..', 'proposal.yaml');
  assert.throws(() => initCompany({ proposalPath: p, dir: c.root, git: false }), /already holds/);
  assert.throws(() => initCompany({ proposalPath: p, dir: process.env.HOME!, git: false }), /refusing/);
});

test('renderOrg shows the tree and the table', () => {
  const org = renderOrg(makeCompany());
  assert.match(org, /- \*\*Marton\*\* \(human\)\n  - \*\*Ada\*\* · CEO/);
  assert.match(org, /    - \*\*Cody\*\* · Engineer/);
});

test('harness launch args map model, autonomy and identity', () => {
  const c = makeCompany();
  const [ada, cody] = c.agents;
  const claudeArgs = ADAPTERS.claude.launchArgs(ada!, c);
  assert.deepEqual(claudeArgs.slice(0, 6), ['--model', 'haiku', '--permission-mode', 'auto', '-n', 'Ada (CEO)']);
  assert.ok(claudeArgs.includes('--append-system-prompt'));
  const codexArgs = ADAPTERS.codex.launchArgs(cody!, c);
  assert.deepEqual(codexArgs.slice(0, 6), ['-m', 'gpt-6-luna', '-s', 'workspace-write', '-a', 'on-request']);
  assert.match(codexArgs.at(-1)!, /^developer_instructions=".*Cody, Engineer/);
  assert.throws(() => ADAPTERS.hermes.launchArgs(ada!, c), /v0.2/);
});

test('durations', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('6h'), 21_600_000);
  assert.equal(parseDuration('off'), null);
  assert.equal(parseDuration(false), null);
  assert.throws(() => parseDuration('soon'), /invalid duration/);
});
