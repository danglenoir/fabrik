import { strict as assert } from 'node:assert';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ADAPTERS, agentEnv } from '../src/harness.ts';
import { codexHome, installCompanySkill, syncCodexHome } from '../src/isolation.ts';
import { makeCompany } from './helpers.ts';

test('the company CODEX_HOME mirrors ~/.codex without the global AGENTS.md', () => {
  const company = makeCompany();
  const user = process.env.CODEX_HOME!;
  mkdirSync(join(user, 'sessions'), { recursive: true });
  writeFileSync(join(user, 'auth.json'), '{}');
  writeFileSync(join(user, 'config.toml'), '');
  writeFileSync(join(user, 'AGENTS.md'), 'Begin work with git status in the infrastructure repo.');

  const home = syncCodexHome(company);
  assert.equal(home, codexHome(company));
  assert.equal(readlinkSync(join(home, 'auth.json')), join(user, 'auth.json'));
  assert.ok(lstatSync(join(home, 'sessions')).isSymbolicLink());
  assert.ok(!existsSync(join(home, 'AGENTS.md')));

  writeFileSync(join(user, 'hooks.json'), '{}');
  rmSync(join(user, 'config.toml'));
  syncCodexHome(company);
  assert.ok(existsSync(join(home, 'hooks.json')), 'new entries are linked');
  assert.throws(() => lstatSync(join(home, 'config.toml')), 'broken links are removed');
});

test('agents ignore personal harness config unless the company opts in', () => {
  const company = makeCompany();
  const ada = company.agents.find((a) => a.slug === 'ada')!;
  const cody = company.agents.find((a) => a.slug === 'cody')!;
  assert.ok(ADAPTERS.claude.launchArgs(ada, company).join(' ').includes('--setting-sources project,local'));
  assert.equal(agentEnv(cody, company).CODEX_HOME, codexHome(company));

  const inheriting = makeCompany({ inherit_user_config: true });
  assert.ok(!ADAPTERS.claude.launchArgs(ada, inheriting).includes('--setting-sources'));
  assert.equal(agentEnv(cody, inheriting).CODEX_HOME, undefined);
});

test('the heartbeat skill ships inside the company for every harness', () => {
  const company = makeCompany();
  const source = readFileSync(join(import.meta.dirname, '..', 'skills', 'fabrik', 'SKILL.md'), 'utf8');
  for (const dir of ['.claude', '.agents']) assert.equal(readFileSync(join(company.root, dir, 'skills', 'fabrik', 'SKILL.md'), 'utf8'), source);
  installCompanySkill(company); // idempotent
});
