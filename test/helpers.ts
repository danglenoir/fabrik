import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { initCompany } from '../src/init.ts';
import type { Company } from '../src/company.ts';
import { HerdrError } from '../src/herdr.ts';
import type { HerdrAgent, HerdrTab, HerdrWorkspace } from '../src/herdr.ts';

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

/** Scriptable stand-in for the herdr CLI wrapper. Agents can be addressed by name or pane id. */
export class FakeHerdr {
  session = 'fabrik-probe-test';
  bin = 'herdr';
  live: HerdrAgent[] = [];
  screens: Record<string, string> = {};
  prompts: Array<{ name: string; text: string }> = [];
  keys: Array<{ name: string; keys: string[] }> = [];
  metadata: Array<{ pane: string; displayAgent?: string }> = [];
  notifications: string[] = [];
  renames: Array<{ target: string; name: string }> = [];
  shellLines: Array<{ pane: string; command: string }> = [];
  started: string[] = [];
  workspaceList: HerdrWorkspace[] = [];
  tabList: HerdrTab[] = [];
  /** When true, a delivered prompt puts the agent into `working`, like a real harness. */
  workOnPrompt = false;
  /** Prompts to drop without effect, per agent (a harness still drawing its splash screen). */
  swallow: Record<string, number> = {};
  /** Screen shown when `agent start` is interrupted by a popup; the agent is left without a name. */
  startPopup: Record<string, string> = {};
  private nextPane = 2;

  addAgent(name: string, status: HerdrAgent['agent_status'] = 'idle', kind = 'claude'): HerdrAgent {
    const n = this.nextPane++;
    const a: HerdrAgent = { name, agent: kind, agent_status: status, completion_seq: 1, pane_id: `w1:p${n}`, tab_id: `w1:t${n}`, workspace_id: 'w1' };
    this.live.push(a);
    return a;
  }

  find(target: string): HerdrAgent | undefined {
    return this.live.find((a) => a.name === target || a.pane_id === target);
  }

  async agents() { return this.live.map((a) => ({ ...a })); }
  async agent(target: string) {
    const a = this.find(target);
    if (!a) throw new HerdrError('agent_not_found', `no agent ${target}`);
    return { ...a };
  }
  async read(target: string) { return this.screens[target] ?? this.screens[this.find(target)?.name ?? ''] ?? ''; }
  async prompt(name: string, text: string) {
    this.prompts.push({ name, text });
    if (this.swallow[name]) { this.swallow[name]--; return {}; }
    const a = this.find(name);
    if (a && this.workOnPrompt) a.agent_status = 'working';
    return {};
  }
  async sendKeys(target: string, keys: string[]) {
    this.keys.push({ name: target, keys });
    const a = this.find(target);
    if (a?.agent_status === 'blocked') a.agent_status = 'idle';
    delete this.screens[target];
    if (a?.name) delete this.screens[a.name];
  }
  async waitFor(target: string, status: string) {
    if (this.find(target)?.agent_status !== status) throw new HerdrError('timeout', `${target} never reached ${status}`);
    return {};
  }
  async renameAgent(target: string, name: string) {
    this.renames.push({ target, name });
    const a = this.find(target);
    if (a) a.name = name;
  }
  async reportMetadata(pane: string, m: { displayAgent?: string }) { this.metadata.push({ pane, displayAgent: m.displayAgent }); }
  async notify(title: string) { this.notifications.push(title); }

  async workspaces() { return [...this.workspaceList]; }
  async createWorkspace(label: string) {
    const workspace = { workspace_id: 'w1', label };
    this.workspaceList.push(workspace);
    const tab = { tab_id: 'w1:t1', workspace_id: 'w1', label: '1' };
    this.tabList.push(tab);
    return { workspace, tab, root_pane: { pane_id: 'w1:p1' } };
  }
  async renameTab(tabId: string, label: string) { const t = this.tabList.find((x) => x.tab_id === tabId); if (t) t.label = label; }
  async tabs(workspaceId: string) { return this.tabList.filter((t) => t.workspace_id === workspaceId); }
  async createTab(workspaceId: string, label: string) {
    const n = this.nextPane++;
    const tab = { tab_id: `w1:t${n}`, workspace_id: workspaceId, label };
    this.tabList.push(tab);
    return { tab, root_pane: { pane_id: `w1:p${n}` } };
  }
  async panes(workspaceId: string) {
    return this.tabList.filter((t) => t.workspace_id === workspaceId).map((t) => ({ pane_id: t.tab_id.replace(':t', ':p'), tab_id: t.tab_id }));
  }
  async runInPane(pane: string, command: string) { this.shellLines.push({ pane, command }); }
  async startAgent(name: string, kind: string, paneId: string) {
    this.started.push(name);
    const tabId = paneId.replace(':p', ':t');
    if (this.startPopup[name]) {
      this.live.push({ name: null, agent: kind, agent_status: 'blocked', completion_seq: 0, pane_id: paneId, tab_id: tabId, workspace_id: 'w1' });
      this.screens[paneId] = this.startPopup[name]!;
      throw new HerdrError('agent_not_ready', `${kind} did not become ready`);
    }
    const a: HerdrAgent = { name, agent: kind, agent_status: 'idle', completion_seq: 0, pane_id: paneId, tab_id: tabId, workspace_id: 'w1' };
    this.live.push(a);
    return a;
  }
}
