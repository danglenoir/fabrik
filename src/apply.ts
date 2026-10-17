import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { herdrName, renderOrg, tabLabel } from './company.ts';
import type { AgentDef, Company } from './company.ts';
import { adapterFor } from './harness.ts';
import { Herdr, HerdrError } from './herdr.ts';
import type { HerdrAgent } from './herdr.ts';
import { withState } from './state.ts';

export interface ApplyOptions {
  dryRun?: boolean;
  acceptTrust?: boolean;
  only?: string[];
  say?: (line: string) => void;
}

export interface ApplyResult {
  started: string[];
  existing: string[];
  needsAttention: Array<{ agent: string; reason: string }>;
  skipped: Array<{ agent: string; reason: string }>;
  orphans: string[];
}

export function introPrompt(company: Company, agent: AgentDef): string {
  const manager = agent.reportsTo ? `You report to ${agent.reportsTo}.` : `You report to ${company.config.company.human}, the human owner.`;
  return `[fabrik intro] Welcome to ${company.config.company.name}. You are ${agent.name}, ${agent.title}. ${manager} ` +
    `Read AGENTS.md in your working directory, ../../COMPANY.md and ../../ORG.md, then reply with one short paragraph: ` +
    `who you are, what you own, and what you will do on your first wake. Do not start any work yet.`;
}

export function metadataFor(company: Company, agent: AgentDef) {
  return {
    displayAgent: `${agent.name} (${agent.title})`,
    tokens: { role: agent.title.toLowerCase(), model: agent.model, harness: agent.harness, org: company.config.company.slug },
    stateLabels: { idle: 'awaiting work', done: 'awaiting work', blocked: 'needs a human' },
  };
}

async function findOrCreateWorkspace(herdr: Herdr, company: Company, knownId: string | null, dryRun: boolean, say: (s: string) => void): Promise<string | null> {
  const list = await herdr.workspaces();
  const found = list.find((w) => w.workspace_id === knownId) ?? list.find((w) => w.label === company.config.herdr.workspace);
  if (found) return found.workspace_id;
  say(`create workspace "${company.config.herdr.workspace}" (cwd ${company.root})`);
  if (dryRun) return null;
  const r = await herdr.createWorkspace(company.config.herdr.workspace, company.root);
  await herdr.renameTab(r.tab.tab_id, 'board').catch(() => undefined);
  return r.workspace.workspace_id;
}

/**
 * An agent that is blocked right after start: accept the folder-trust prompt when allowed,
 * otherwise explain what the human has to do. Returns null once the agent is ready.
 */
async function handleStartupBlock(herdr: Herdr, company: Company, agent: AgentDef, acceptTrust?: boolean): Promise<string | null> {
  const name = herdrName(company, agent);
  const adapter = adapterFor(agent);
  const screen = await herdr.read(name).catch(() => '');
  if (!adapter.trust || !adapter.trust.pattern.test(screen)) return `blocked during startup; check tab "${tabLabel(agent)}"`;
  if (!acceptTrust || !adapter.trust.keys) {
    return `${agent.harness} asks to trust ${agent.dir}: answer in tab "${tabLabel(agent)}"${adapter.trust.keys ? ' or rerun with --accept-trust' : ''}`;
  }
  await herdr.sendKeys(name, adapter.trust.keys);
  await herdr.waitFor(name, 'idle', 60_000).catch(() => undefined);
  const after = await herdr.agent(name).catch(() => null);
  if (after && after.agent_status !== 'idle' && after.agent_status !== 'done') return `still ${after.agent_status} after accepting trust; check tab "${tabLabel(agent)}"`;
  return null;
}

/** Re-report display metadata for every live fabrik agent. herdr drops it on server restart. */
export async function reapplyMetadata(company: Company, herdr: Herdr, live?: HerdrAgent[]): Promise<number> {
  const agents = live ?? (await herdr.agents());
  let n = 0;
  for (const agent of company.agents) {
    const l = agents.find((a) => a.name === herdrName(company, agent));
    if (!l) continue;
    await herdr.reportMetadata(l.pane_id, metadataFor(company, agent)).catch(() => undefined);
    n++;
  }
  return n;
}

export async function apply(company: Company, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const say = opts.say ?? (() => undefined);
  const dryRun = !!opts.dryRun;
  const herdr = new Herdr(company.config.herdr.session);
  const result: ApplyResult = { started: [], existing: [], needsAttention: [], skipped: [], orphans: [] };

  const knownWs = await withState(company, (s) => s.workspaceId);
  const wsId = await findOrCreateWorkspace(herdr, company, knownWs, dryRun, say);
  if (wsId && !dryRun) await withState(company, (s) => { s.workspaceId = wsId; });

  const live = await herdr.agents();
  const tabs = wsId ? await herdr.tabs(wsId) : [];
  const names = new Set(company.agents.map((a) => herdrName(company, a)));
  const prefix = company.config.herdr.agentPrefix;
  result.orphans = live
    .filter((a) => a.name && a.workspace_id === wsId && !names.has(a.name) && (prefix === '' || a.name.startsWith(prefix)))
    .map((a) => a.name as string);

  for (const agent of company.agents) {
    const name = herdrName(company, agent);
    if (opts.only && !opts.only.includes(agent.slug)) continue;
    if (!agent.enabled) { result.skipped.push({ agent: agent.slug, reason: 'disabled in AGENTS.md' }); continue; }
    const adapter = adapterFor(agent);
    if (!adapter.supported) { result.skipped.push({ agent: agent.slug, reason: `${agent.harness} is not supported yet` }); continue; }

    const running = live.find((a) => a.name === name);
    if (running && running.agent_status === 'blocked' && !dryRun) {
      // Typically the folder-trust prompt from an earlier `apply` without --accept-trust.
      const trouble = await handleStartupBlock(herdr, company, agent, opts.acceptTrust);
      if (trouble) { result.needsAttention.push({ agent: agent.slug, reason: trouble }); continue; }
      running.agent_status = 'idle';
    }
    if (running) {
      result.existing.push(agent.slug);
      if (!dryRun) {
        await herdr.reportMetadata(running.pane_id, metadataFor(company, agent)).catch(() => undefined);
        const introduced = await withState(company, (s) => {
          const a = s.agents[agent.slug]!;
          a.paneId = running.pane_id;
          a.tabId = running.tab_id;
          return a.introduced;
        });
        // An agent started by hand after a trust prompt still needs its introduction.
        if (!introduced && (running.agent_status === 'idle' || running.agent_status === 'done')) {
          await herdr.prompt(name, introPrompt(company, agent));
          await withState(company, (s) => { s.agents[agent.slug]!.introduced = true; });
        }
      }
      continue;
    }
    if (live.some((a) => a.name === name && a.workspace_id !== wsId)) {
      result.needsAttention.push({ agent: agent.slug, reason: `herdr agent name "${name}" is taken outside the company workspace` });
      continue;
    }

    const label = tabLabel(agent);
    say(`start ${name}: tab "${label}", ${agent.harness} ${adapter.launchArgs(agent, company).slice(0, 2).join(' ')} …`);
    if (dryRun || !wsId) { result.started.push(agent.slug); continue; }

    // Reuse an existing tab with this label if its root pane is free (e.g. the agent exited), else open a new one.
    let paneId: string;
    let tabId: string;
    const tab = tabs.find((t) => t.label === label);
    const panes = tab ? (await herdr.panes(wsId)).filter((p) => p.tab_id === tab.tab_id) : [];
    if (tab && panes[0]) {
      paneId = panes[0].pane_id;
      tabId = tab.tab_id;
    } else {
      const created = await herdr.createTab(wsId, label, agent.dir);
      paneId = created.root_pane.pane_id;
      tabId = created.tab.tab_id;
    }

    try {
      await herdr.startAgent(name, adapter.harness, paneId, adapter.launchArgs(agent, company), company.config.herdr.startTimeoutMs);
    } catch (err) {
      if (!(err instanceof HerdrError) || err.code !== 'agent_not_ready') {
        result.needsAttention.push({ agent: agent.slug, reason: `start failed: ${(err as Error).message}` });
        continue;
      }
      await withState(company, (s) => { const a = s.agents[agent.slug]!; a.paneId = paneId; a.tabId = tabId; });
      const trouble = await handleStartupBlock(herdr, company, agent, opts.acceptTrust);
      if (trouble) { result.needsAttention.push({ agent: agent.slug, reason: trouble }); continue; }
    }

    await herdr.reportMetadata(paneId, metadataFor(company, agent)).catch(() => undefined);
    const introduced = await withState(company, (s) => {
      const a = s.agents[agent.slug]!;
      a.paneId = paneId;
      a.tabId = tabId;
      return a.introduced;
    });
    if (!introduced) {
      await herdr.prompt(name, introPrompt(company, agent));
      await withState(company, (s) => { s.agents[agent.slug]!.introduced = true; });
    }
    result.started.push(agent.slug);
  }

  if (!dryRun) writeFileSync(join(company.root, 'ORG.md'), renderOrg(company));
  return result;
}
