import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { initCompany } from '../src/init.ts';
import type { Company } from '../src/company.ts';
import type { HerdrAgent } from '../src/herdr.ts';

export function tmp(prefix = 'fabrik-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function proposal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    company: { slug: 'acme', name: 'Acme Studio', human: 'Marton', mission: 'Ship things', goal: 'First release' },
    context: { stack: 'Plane + Obsidian' },
    herdr: { session: 'fabrik-probe-test', workspace: 'acme' },
    heartbeat: { cooldown: '0s', max_concurrent: 2, max_runs_per_day: 5, rotate_after_runs: 100 },
    router: { unassigned: 'ada' },
    agents: [
      { slug: 'ada', name: 'Ada', title: 'CEO', reports_to: null, harness: 'claude', model: 'haiku', autonomy: 'medium', remit: 'Owns the backlog.' },
      { slug: 'cody', name: 'Cody', title: 'Engineer', reports_to: 'ada', harness: 'codex', model: 'gpt-6-luna', autonomy: 'low', remit: 'Writes code.' },
    ],
    ...extra,
  };
}

/** A fresh company in a temp dir. FABRIK_CONFIG_DIR is redirected so secrets and the registry never touch ~/.config. */
export function makeCompany(extra: Record<string, unknown> = {}): Company {
  const dir = tmp();
  process.env.FABRIK_CONFIG_DIR = join(dir, 'cfg');
  const path = join(dir, 'proposal.yaml');
  writeFileSync(path, stringify(proposal(extra)));
  return initCompany({ proposalPath: path, dir: join(dir, 'acme'), git: false });
}

/** Scriptable stand-in for the herdr CLI wrapper. */
export class FakeHerdr {
  session = 'fabrik-probe-test';
  bin = 'herdr';
  live: HerdrAgent[] = [];
  screens: Record<string, string> = {};
  prompts: Array<{ name: string; text: string }> = [];
  keys: Array<{ name: string; keys: string[] }> = [];
  metadata: Array<{ pane: string; displayAgent?: string }> = [];
  notifications: string[] = [];

  addAgent(name: string, status: HerdrAgent['agent_status'] = 'idle'): HerdrAgent {
    const a: HerdrAgent = { name, agent: 'claude', agent_status: status, completion_seq: 1, pane_id: `w1:p${this.live.length + 2}`, tab_id: `w1:t${this.live.length + 2}`, workspace_id: 'w1' };
    this.live.push(a);
    return a;
  }

  async agents() { return this.live.map((a) => ({ ...a })); }
  async read(name: string) { return this.screens[name] ?? ''; }
  async prompt(name: string, text: string) { this.prompts.push({ name, text }); return {}; }
  async sendKeys(name: string, keys: string[]) { this.keys.push({ name, keys }); delete this.screens[name]; }
  async reportMetadata(pane: string, m: { displayAgent?: string }) { this.metadata.push({ pane, displayAgent: m.displayAgent }); }
  async notify(title: string) { this.notifications.push(title); }
}
