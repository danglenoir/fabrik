import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { herdrName, renderOrg, tabLabel } from './company.ts';
import type { AgentDef, Company } from './company.ts';
import { adapterFor, agentEnv, launchSignature, shellExport } from './harness.ts';
import { Herdr, HerdrError } from './herdr.ts';
import { installCompanySkill, syncCodexHome } from './isolation.ts';
import type { HerdrAgent } from './herdr.ts';
import { withState } from './state.ts';
import { sleep } from './util.ts';

export interface ApplyOptions {
  dryRun?: boolean;
  acceptTrust?: boolean;
  only?: string[];
  say?: (line: string) => void;
  herdr?: Herdr; // tests inject a fake
}

export interface ApplyResult {
  started: string[];
  restarted: string[]; // new launch settings (model, effort, gear)
  stopped: string[]; // switched off (enabled: false)
  wouldStart: string[]; // dry run only
  introduced: string[];
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
 * The live herdr agent for `agent`. herdr loses the agent name when a start is interrupted (an
 * update prompt, a trust prompt answered by hand), so fall back to the unnamed agent of the right
 * kind in the pane fabrik last used for it, and give it its name back.
 */
export async function locateAgent(herdr: Herdr, company: Company, agent: AgentDef, live: HerdrAgent[], paneId: string | null): Promise<HerdrAgent | undefined> {
  const name = herdrName(company, agent);
  const named = live.find((a) => a.name === name);
  if (named || !paneId) return named;
  const unnamed = live.find((a) => a.pane_id === paneId && !a.name && a.agent === agent.harness);
  if (!unnamed) return undefined;
  await herdr.renameAgent(unnamed.pane_id, name);
  unnamed.name = name;
  return unnamed;
}

function lastLine(screen: string): string {
  const line = screen.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/**
 * An agent that is blocked right after start: dismiss known popups (update prompts), accept the
 * folder-trust prompt when allowed, otherwise explain what the human has to do. Returns null once
 * the agent in pane `target` is ready.
 */
async function handleStartupBlock(herdr: Herdr, agent: AgentDef, target: string, acceptTrust?: boolean): Promise<string | null> {
  const adapter = adapterFor(agent);
  for (let round = 0; round < 3; round++) {
    const screen = await herdr.read(target).catch(() => '');
    const popup = adapter.dialogs.find((d) => d.keys && d.pattern.test(screen));
    if (popup) {
      await herdr.sendKeys(target, popup.keys!);
      await herdr.waitFor(target, 'idle', 15_000).catch(() => undefined);
      const after = await herdr.agent(target).catch(() => null);
      if (after && (after.agent_status === 'idle' || after.agent_status === 'done')) return null;
      continue; // another popup may follow, e.g. the trust prompt
    }
    if (!adapter.trust || !adapter.trust.pattern.test(screen)) {
      const hint = lastLine(screen);
      return `blocked during startup${hint ? ` ("${hint}")` : ''}; answer it in tab "${tabLabel(agent)}", then run fabrik apply again`;
    }
    if (!acceptTrust || !adapter.trust.keys) {
      return `${agent.harness} asks to trust ${agent.dir}: answer in tab "${tabLabel(agent)}"${adapter.trust.keys ? ' or rerun with --accept-trust' : ', then run fabrik apply again'}`;
    }
    await herdr.sendKeys(target, adapter.trust.keys);
    await herdr.waitFor(target, 'idle', 60_000).catch(() => undefined);
    const after = await herdr.agent(target).catch(() => null);
    if (after && after.agent_status !== 'idle' && after.agent_status !== 'done') return `still ${after.agent_status} after accepting trust; check tab "${tabLabel(agent)}"`;
    return null;
  }
  return `still blocked after dismissing startup popups; check tab "${tabLabel(agent)}"`;
}

/**
 * Send the one-time introduction and confirm the agent took it: it must start working or finish
 * a turn. A prompt typed while a harness is still drawing its splash screen can be swallowed, so
 * try twice before giving up.
 */
async function sendIntro(herdr: Herdr, company: Company, agent: AgentDef): Promise<boolean> {
  const name = herdrName(company, agent);
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await herdr.agent(name).catch(() => null);
    await herdr.prompt(name, introPrompt(company, agent));
    if (await herdr.waitFor(name, 'working', 20_000).then(() => true, () => false)) return true;
    const after = await herdr.agent(name).catch(() => null);
    if (after && (after.agent_status === 'working' || (before && after.completion_seq > before.completion_seq))) return true;
  }
  return false;
}

async function introduce(herdr: Herdr, company: Company, agent: AgentDef, result: ApplyResult): Promise<void> {
  if (await sendIntro(herdr, company, agent)) {
    await withState(company, (s) => { s.agents[agent.slug]!.introduced = true; });
    result.introduced.push(agent.slug);
  } else {
    result.needsAttention.push({ agent: agent.slug, reason: `did not pick up its introduction; check tab "${tabLabel(agent)}", then run fabrik apply again` });
  }
}

/** Start the agent's harness in `paneId`, which must be at a shell prompt. Returns a problem for the human, or null. */
async function startInPane(herdr: Herdr, company: Company, agent: AgentDef, paneId: string, tabId: string, acceptTrust?: boolean): Promise<string | null> {
  const adapter = adapterFor(agent);
  try {
    // herdr types the start command into the pane's shell, so variables exported there reach the harness.
    await herdr.runInPane(paneId, shellExport(agentEnv(agent, company)));
    await herdr.startAgent(herdrName(company, agent), adapter.harness, paneId, adapter.launchArgs(agent, company), company.config.herdr.startTimeoutMs);
  } catch (err) {
    if (!(err instanceof HerdrError) || err.code !== 'agent_not_ready') return `start failed: ${(err as Error).message}`;
    await withState(company, (s) => { const a = s.agents[agent.slug]!; a.paneId = paneId; a.tabId = tabId; });
    const trouble = await handleStartupBlock(herdr, agent, paneId, acceptTrust);
    if (trouble) return trouble;
    // The interrupted start may have left the agent without its name.
    await locateAgent(herdr, company, agent, await herdr.agents(), paneId);
  }
  await herdr.reportMetadata(paneId, metadataFor(company, agent)).catch(() => undefined);
  await withState(company, (s) => {
    const a = s.agents[agent.slug]!;
    a.paneId = paneId;
    a.tabId = tabId;
    a.launchSig = launchSignature(agent, company);
  });
  return null;
}

/** Quit the agent's harness (its exit command, then Ctrl-C twice) and wait until its pane is back at the shell. */
export async function exitHarness(herdr: Herdr, company: Company, agent: AgentDef, live: HerdrAgent): Promise<boolean> {
  const name = herdrName(company, agent);
  const exited = async (ms: number) => {
    for (const end = Date.now() + ms; ;) {
      const agents = await herdr.agents().catch(() => null);
      if (agents && !agents.some((a) => a.pane_id === live.pane_id)) return true;
      if (Date.now() > end) return false;
      await sleep(500);
    }
  };
  await herdr.prompt(name, adapterFor(agent).exitCommand).catch(() => undefined);
  if (await exited(15_000)) return true;
  for (let i = 0; i < 2; i++) await herdr.sendKeys(name, ['ctrl+c']).catch(() => undefined);
  return exited(10_000);
}

/**
 * Restart an idle agent so new launch settings (model, effort, gear) take effect. Its chat is lost;
 * tickets, notes and the queue are not.
 */
export async function restartAgent(herdr: Herdr, company: Company, agent: AgentDef, live: HerdrAgent): Promise<string | null> {
  if (!(await exitHarness(herdr, company, agent, live))) return `did not quit for a restart with new settings; quit it in tab "${tabLabel(agent)}", then run fabrik apply`;
  return startInPane(herdr, company, agent, live.pane_id, live.tab_id);
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
  const herdr = opts.herdr ?? new Herdr(company.config.herdr.session);
  const result: ApplyResult = { started: [], restarted: [], stopped: [], wouldStart: [], introduced: [], existing: [], needsAttention: [], skipped: [], orphans: [] };

  const known = await withState(company, (s) => ({ workspaceId: s.workspaceId, panes: Object.fromEntries(Object.entries(s.agents).map(([k, a]) => [k, a.paneId])) }));
  const knownWs = known.workspaceId;
  const wsId = await findOrCreateWorkspace(herdr, company, knownWs, dryRun, say);
  if (wsId && !dryRun) await withState(company, (s) => { s.workspaceId = wsId; });

  if (!dryRun) {
    installCompanySkill(company); // keep the project copy of the heartbeat skill current
    if (company.agents.some((a) => a.enabled && a.harness === 'codex')) syncCodexHome(company);
  }

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
    const adapter = adapterFor(agent);
    if (!adapter.supported) { result.skipped.push({ agent: agent.slug, reason: `${agent.harness} is not supported yet` }); continue; }

    const running = dryRun ? live.find((a) => a.name === name) : await locateAgent(herdr, company, agent, live, known.panes[agent.slug] ?? null);
    const idle = running?.agent_status === 'idle' || running?.agent_status === 'done';
    if (!agent.enabled) {
      if (!running || dryRun) result.skipped.push({ agent: agent.slug, reason: 'switched off (enabled: false)' });
      else if (!idle) result.skipped.push({ agent: agent.slug, reason: 'switched off; it stops once idle' });
      else if (await exitHarness(herdr, company, agent, running)) result.stopped.push(agent.slug);
      else result.needsAttention.push({ agent: agent.slug, reason: `switched off but did not quit; quit it in tab "${tabLabel(agent)}"` });
      continue;
    }
    if (running && running.agent_status === 'blocked' && !dryRun) {
      // Typically the folder-trust prompt from an earlier `apply` without --accept-trust.
      const trouble = await handleStartupBlock(herdr, agent, running.pane_id, opts.acceptTrust);
      if (trouble) { result.needsAttention.push({ agent: agent.slug, reason: trouble }); continue; }
      running.agent_status = 'idle';
    }
    if (running) {
      if (dryRun) { result.existing.push(agent.slug); continue; }
      await herdr.reportMetadata(running.pane_id, metadataFor(company, agent)).catch(() => undefined);
      const sig = launchSignature(agent, company);
      const before = await withState(company, (s) => {
        const a = s.agents[agent.slug]!;
        a.paneId = running.pane_id;
        a.tabId = running.tab_id;
        const prev = { introduced: a.introduced, launchSig: a.launchSig };
        a.launchSig ??= sig; // started by an older fabrik: adopt, do not restart
        return prev;
      });
      if (before.launchSig !== null && before.launchSig !== sig) {
        if (running.agent_status !== 'idle' && running.agent_status !== 'done') {
          result.existing.push(agent.slug);
          say(`${agent.slug} has new settings and restarts once idle`);
          continue;
        }
        const trouble = await restartAgent(herdr, company, agent, running);
        if (trouble) result.needsAttention.push({ agent: agent.slug, reason: trouble });
        else result.restarted.push(agent.slug);
        continue;
      }
      result.existing.push(agent.slug);
      // An agent started by hand after a trust prompt still needs its introduction.
      if (!before.introduced && (running.agent_status === 'idle' || running.agent_status === 'done')) await introduce(herdr, company, agent, result);
      continue;
    }
    if (live.some((a) => a.name === name && a.workspace_id !== wsId)) {
      result.needsAttention.push({ agent: agent.slug, reason: `herdr agent name "${name}" is taken outside the company workspace` });
      continue;
    }

    const label = tabLabel(agent);
    say(`start ${name}: tab "${label}", ${agent.harness} ${adapter.launchArgs(agent, company).slice(0, 2).join(' ')} …`);
    if (dryRun || !wsId) { result.wouldStart.push(agent.slug); continue; }

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

    const trouble = await startInPane(herdr, company, agent, paneId, tabId, opts.acceptTrust);
    if (trouble) { result.needsAttention.push({ agent: agent.slug, reason: trouble }); continue; }
    result.started.push(agent.slug);
    if (!(await withState(company, (s) => s.agents[agent.slug]!.introduced))) await introduce(herdr, company, agent, result);
  }

  if (!dryRun) writeFileSync(join(company.root, 'ORG.md'), renderOrg(company));
  return result;
}
