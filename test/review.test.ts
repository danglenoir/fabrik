import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { loadCompany } from '../src/company.ts';
import { companyTarget, keyAction, proposalTarget, renderReview, summary, update } from '../src/review.ts';
import type { Review } from '../src/review.ts';
import { makeCompany, tmp } from './helpers.ts';

const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');
const models = async (h: string) => ({ claude: ['haiku', 'sonnet', 'opus'], codex: ['gpt-6-luna', 'gpt-6-sol'], grok: ['grok-4.7'] } as Record<string, string[]>)[h] ?? null;

/** A proposal as the onboarding skill writes it: agents as one-line flow maps. */
function proposalFile(): string {
  const path = join(tmp('fabrik-review-'), 'acme.yaml');
  writeFileSync(path, `# from the onboarding interview
company: { slug: acme, name: Acme Studio, human: Marton }
router: { unassigned: ada }
agents:
  - { slug: ada, name: Ada, title: CEO, reports_to: null, harness: claude, model: haiku, remit: "Owns the backlog." }
  - { slug: cody, name: Cody, title: Engineer, reports_to: ada, harness: codex, model: gpt-6-luna, remit: "Writes code." }
`);
  return path;
}

test('keys map to picker actions', () => {
  assert.equal(keyAction('\u001b[A'), 'up');
  assert.equal(keyAction('\u001b[C'), 'right');
  assert.equal(keyAction(' '), 'toggle');
  assert.equal(keyAction('\r'), 'accept');
  assert.equal(keyAction('\u001b'), 'cancel');
  assert.equal(keyAction('x'), null);
});

test('arrows change models, e cycles effort, space switches agents, the top agent stays on', async () => {
  const r: Review = await proposalTarget(proposalFile(), models).load();
  assert.deepEqual(r.agents.map((a) => a.slug), ['ada', 'cody']);
  assert.equal(r.gear, 'steady', 'steady unless the proposal says otherwise');

  update(r, 'right');
  assert.equal(r.agents[0]!.model, 'sonnet');
  update(r, 'left');
  update(r, 'left');
  assert.equal(r.agents[0]!.model, 'opus', 'wraps around');
  update(r, 'effort');
  assert.equal(r.agents[0]!.effort, 'low', 'no effort yet: starts at the lowest');
  update(r, 'toggle');
  assert.equal(r.agents[0]!.enabled, true);
  assert.match(r.notice, /ada stays on: the top of the org/);

  update(r, 'down');
  update(r, 'toggle');
  assert.equal(r.agents[1]!.enabled, false);
  update(r, 'down');
  update(r, 'down');
  assert.equal(r.row, 2, 'the gear row is the last row');
  update(r, 'right');
  assert.equal(r.gear, 'turbo');
  assert.equal(update(r, 'accept'), 'accept');
  assert.equal(summary(r), 'gear turbo; ada claude/opus (low), cody off');
});

test('the picker draws the team and both gears', async () => {
  const r = await proposalTarget(proposalFile(), models).load();
  const lines = renderReview(r, 90, 24).map(plain);
  assert.match(lines[0]!, /Acme Studio · review your team/);
  assert.match(lines[2]!, /^❯ ✔ ada +CEO +claude +‹ haiku › +effort ‹ - ›/);
  assert.ok(lines.some((l) => /Gear {2}● steady +protects your tokens/.test(l)));
  assert.ok(lines.some((l) => /○ turbo +more autonomous/.test(l)));
  assert.match(lines.at(-1)!, /enter accept · esc cancel/);
  for (const l of lines) assert.ok(l.length <= 90, `"${l}" is wider than the popup`);
});

test('accepting writes the proposal in place and keeps its comments', async () => {
  const path = proposalFile();
  const target = proposalTarget(path, models);
  const r = await target.load();
  update(r, 'right');
  update(r, 'down');
  update(r, 'toggle');
  update(r, 'gear');
  target.save(r);
  const text = readFileSync(path, 'utf8');
  assert.match(text, /^# from the onboarding interview/);
  const saved = parse(text);
  assert.equal(saved.gear, 'turbo');
  assert.equal(saved.agents[0].model, 'sonnet');
  assert.equal(saved.agents[1].enabled, false);
  assert.equal(saved.agents[0].remit, 'Owns the backlog.', 'everything else untouched');
  assert.match(text, /^company: .*\ngear: turbo\n/m, 'a new gear key goes right after company');
  assert.doesNotMatch(text, /^ +- \{/m, 'edited agents are written as block mappings');
});

test('reviewing a running company edits agent files and the gear', async () => {
  const company = makeCompany();
  const target = companyTarget(company, models);
  const r = await target.load();
  update(r, 'down');
  update(r, 'right');
  update(r, 'effort');
  update(r, 'gear');
  target.save(r);
  const after = loadCompany(company.root);
  assert.equal(after.config.gear, 'turbo');
  const cody = after.agents.find((a) => a.slug === 'cody')!;
  assert.equal(cody.model, 'gpt-6-sol');
  assert.equal(cody.effort, 'low');
});
