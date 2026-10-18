import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ADAPTERS } from '../src/harness.ts';
import { makeCompany } from './helpers.ts';

const company = makeCompany();
const agent = (slug: string, autonomy: 'low' | 'medium' | 'high') => ({ ...company.agents.find((a) => a.slug === slug)!, autonomy });
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

test('autonomy low asks before edits in claude and grok, medium and high do not', () => {
  assert.equal(flag(ADAPTERS.claude.launchArgs(agent('ada', 'low'), company), '--permission-mode'), 'default');
  assert.equal(flag(ADAPTERS.claude.launchArgs(agent('ada', 'medium'), company), '--permission-mode'), 'auto');
  assert.equal(flag(ADAPTERS.grok.launchArgs({ ...agent('ada', 'low'), harness: 'grok' }, company), '--permission-mode'), 'default');
  assert.equal(flag(ADAPTERS.grok.launchArgs({ ...agent('ada', 'high'), harness: 'grok' }, company), '--permission-mode'), 'bypassPermissions');
});

test('the fabrik CLI never needs approval', () => {
  assert.equal(flag(ADAPTERS.claude.launchArgs(agent('ada', 'low'), company), '--allowedTools'), 'Bash(fabrik *)');
  assert.equal(flag(ADAPTERS.grok.launchArgs({ ...agent('ada', 'low'), harness: 'grok' }, company), '--allow'), 'Bash(fabrik *)');
});

test('codex starts sandboxed with network access and without the update prompt', () => {
  const args = ADAPTERS.codex.launchArgs(agent('cody', 'low'), company);
  assert.deepEqual(args.slice(2, 6), ['-s', 'workspace-write', '-a', 'on-request']);
  assert.ok(args.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(args.includes('check_for_update_on_startup=false'));
});
