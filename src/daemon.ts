import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { herdrName } from './company.ts';
import type { AgentDef, Company } from './company.ts';
import { locateAgent, reapplyMetadata } from './apply.ts';
import { adapterFor } from './harness.ts';
import { Herdr } from './herdr.ts';
import type { HerdrAgent } from './herdr.ts';
import { appendAttention, scanInbox, writeStatusCard } from './obsidian.ts';
import { Plane } from './plane.ts';
import type { PlaneComment } from './plane.ts';
import { diffIssue, enqueue, wakeText } from './rules.ts';
import type { WakeEvent } from './rules.ts';
import { getSecret } from './secrets.ts';
import { loadState, logEvent, logRun, reportPath, withState } from './state.ts';
import type { AgentState, CompanyState } from './state.ts';
import { FabrikError, log, readJson, shortId, sleep, today } from './util.ts';

const STALL_MS = 120_000;
const MAX_ITEMS_PER_WAKE = 5;

export function daemonLockPath(company: Company): string {
  return join(company.stateDir, 'daemon.lock');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function daemonPid(company: Company): number | null {
  const path = daemonLockPath(company);
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : null;
}

function takeLock(company: Company): void {
  mkdirSync(company.stateDir, { recursive: true });
  const path = daemonLockPath(company);
  const holder = daemonPid(company);
  if (holder && holder !== process.pid) throw new FabrikError('daemon_running', `fabrik daemon already running (pid ${holder})`);
  if (existsSync(path)) unlinkSync(path);
  const fd = openSync(path, 'wx');
  writeSync(fd, String(process.pid));
  closeSync(fd);
  const release = () => { try { if (readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path); } catch { /* gone */ } };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { release(); process.exit(0); });
}

/** Manual wakes are files dropped by `fabrik wake`, so the CLI never touches the queue directly. */
export function wakeDir(company: Company): string {
  return join(company.stateDir, 'wake');
}

function takeManualWakes(company: Company): WakeEvent[] {
  const dir = wakeDir(company);
  if (!existsSync(dir)) return [];
  const out: WakeEvent[] = [];
  for (const f of readdirSync(dir).sort()) {
    const path = join(dir, f);
    try {
      const w = JSON.parse(readFileSync(path, 'utf8'));
      out.push({ agent: String(w.agent), key: String(w.key ?? 'manual'), reason: String(w.reason ?? 'manual wake') });
    } catch { /* ignore malformed */ }
    try { unlinkSync(path); } catch { /* raced */ }
  }
  return out;
}

export class Daemon {
  company: Company;
  herdr: Herdr;
  plane: Plane | null;
  private metadataApplied = false;
  private lastLiveCount = -1;

  constructor(company: Company) {
    this.company = company;
    this.herdr = new Herdr(company.config.herdr.session);
    const p = company.config.plane;
    this.plane = p ? new Plane(p, getSecret(company, p.keyEnv)) : null;
  }

  /** Poll Plane and return wake events; updates snapshots in `state`. */
  async pollPlane(state: CompanyState): Promise<WakeEvent[]> {
    const cfg = this.company.config.plane;
    if (!this.plane || !cfg) return [];
    const bootstrap = state.plane.hwm === null;
    const since = state.plane.hwm ? new Date(Date.parse(state.plane.hwm) - 10_000).toISOString() : null;
    const events: WakeEvent[] = [];
    let hwm = state.plane.hwm;
    for (const project of cfg.projects) {
      const issues = await this.plane.issuesUpdatedSince(project, since, bootstrap ? 20 : 4);
      for (const issue of issues) {
        if (!hwm || issue.updatedAt > hwm) hwm = issue.updatedAt;
        const prev = state.plane.snaps[issue.id];
        const unchanged = prev && prev.updatedAt === issue.updatedAt;
        let fresh: PlaneComment[] = [];
        const watched = issue.labels.some((l) => l.startsWith(cfg.agentLabelPrefix)) || state.plane.askHuman[issue.id] || !bootstrap;
        if (!unchanged && watched && issue.stateGroup !== 'cancelled') {
          const comments = await this.plane.comments(issue);
          const seen = new Set(state.plane.seenComments[issue.id] ?? []);
          fresh = comments.filter((c) => !seen.has(c.id));
          state.plane.seenComments[issue.id] = comments.map((c) => c.id).slice(-200);
        }
        if (!bootstrap && !unchanged) {
          events.push(...diffIssue(this.company, prev, issue, fresh, { snaps: state.plane.snaps, askHuman: state.plane.askHuman }));
        }
        state.plane.snaps[issue.id] = { key: issue.key, labels: issue.labels, stateGroup: issue.stateGroup, parent: issue.parent, updatedAt: issue.updatedAt };
      }
    }
    state.plane.hwm = hwm ?? new Date(0).toISOString();
    state.plane.lastPoll = Date.now();
    if (bootstrap) log(`plane: bootstrapped ${Object.keys(state.plane.snaps).length} tickets (no wakes on first poll)`);
    return events;
  }

  inboxEvents(state: CompanyState): WakeEvent[] {
    const events: WakeEvent[] = [];
    const slugs = new Set(this.company.agents.map((a) => a.slug));
    for (const note of scanInbox(this.company)) {
      if (state.inbox[note.path] === note.mtimeMs) continue;
      state.inbox[note.path] = note.mtimeMs;
      for (const to of note.to) if (slugs.has(to)) events.push({ agent: to, key: `note:${note.path}`, reason: 'inbox note' });
    }
    return events;
  }

  timerEvents(state: CompanyState, now: number): WakeEvent[] {
    const events: WakeEvent[] = [];
    const prefix = this.company.config.plane?.agentLabelPrefix ?? 'agent:';
    for (const agent of this.company.agents) {
      const every = agent.timerMs ?? this.company.config.heartbeat.timerMs;
      const s = state.agents[agent.slug]!;
      if (!every || now - Math.max(s.lastRunEnd, s.lastTimerCheck) < every) continue;
      s.lastTimerCheck = now;
      // Never wake a model to look at an empty inbox.
      const openWork = Object.values(state.plane.snaps).some((i) => i.labels.includes(prefix + agent.slug) && (i.stateGroup === 'unstarted' || i.stateGroup === 'started'));
      if (openWork) events.push({ agent: agent.slug, key: 'timer', reason: 'scheduled check: open tickets' });
    }
    return events;
  }

  private escalate(agent: AgentDef, text: string): void {
    const line = `${agent.slug}: ${text}`;
    log('attention', line);
    appendAttention(this.company, line);
    void this.herdr.notify(`fabrik: ${agent.slug} needs you`, text);
    logEvent(this.company, { type: 'escalation', agent: agent.slug, text });
  }

  /** Close finished runs, detect stalls/blocks/timeouts. */
  reconcile(agent: AgentDef, s: AgentState, live: HerdrAgent | undefined, now: number): void {
    const run = s.inflight;
    if (!run) return;
    if (!live) {
      this.escalate(agent, `agent is not running in herdr (run ${run.runId} abandoned)`);
      s.queue.unshift(...run.items);
      s.inflight = null;
      s.failures++;
      return;
    }
    const st = live.agent_status;
    if (st === 'working') run.sawWorking = true;
    // A fresh harness session (after /clear or /new) may not report completion_seq yet.
    const advanced = (live.completion_seq ?? 0) > (run.seqBefore ?? 0);
    const report = readJson<{ summary?: string; at?: number } | null>(reportPath(this.company, agent.slug), null);
    const reported = !!report && (report.at ?? 0) >= run.startedAt;
    // A short run can start and finish between two ticks; its report proves it ran.
    if ((st === 'idle' || st === 'done') && (advanced || run.sawWorking || reported)) {
      logRun(this.company, { run: run.runId, agent: agent.slug, outcome: 'done', reported, summary: reported ? report!.summary : null, items: run.items.map((i) => i.key), ms: now - run.startedAt });
      s.failures = reported ? 0 : s.failures + 1;
      s.inflight = null;
      s.lastRunEnd = now;
      if (s.failures >= 3) {
        s.paused = true;
        this.escalate(agent, 'paused after 3 runs without a `fabrik run done` report; check the tab, then `fabrik resume ' + agent.slug + '`');
      }
      return;
    }
    if (st === 'blocked' && !run.escalated) {
      run.escalated = true;
      this.escalate(agent, `waiting for approval in its herdr tab (run ${run.runId})`);
      return;
    }
    if (!run.sawWorking && !advanced && !reported && now - run.startedAt > STALL_MS) {
      this.escalate(agent, `did not react to wake ${run.runId}; it will be retried`);
      s.queue.unshift(...run.items);
      s.inflight = null;
      s.failures++;
      return;
    }
    if (now - run.startedAt > this.company.config.heartbeat.runTimeoutMs) {
      logRun(this.company, { run: run.runId, agent: agent.slug, outcome: 'timeout', items: run.items.map((i) => i.key) });
      s.inflight = null;
      s.paused = true;
      s.failures++;
      this.escalate(agent, `run ${run.runId} exceeded ${Math.round(this.company.config.heartbeat.runTimeoutMs / 60_000)} min; agent paused (not killed)`);
    }
  }

  /** Decide whether to deliver now. Returns a reason when the agent must wait. */
  gate(agent: AgentDef, s: AgentState, live: HerdrAgent | undefined, now: number, inflightCount: number): string | null {
    const hb = this.company.config.heartbeat;
    if (s.queue.length === 0) return 'empty queue';
    if (s.paused) return 'paused';
    if (s.inflight) return 'run in progress';
    if (!live) return 'not running';
    if (live.agent_status !== 'idle' && live.agent_status !== 'done') return `status ${live.agent_status}`;
    if (inflightCount >= hb.maxConcurrent) return 'company concurrency limit';
    if (now - s.lastRunEnd < hb.cooldownMs) return 'cooldown';
    if (s.runsDate === today() && s.runsToday >= hb.maxRunsPerDay) return 'daily run cap';
    return null;
  }

  async deliver(agent: AgentDef, s: AgentState, live: HerdrAgent, now: number): Promise<void> {
    const name = herdrName(this.company, agent);
    const adapter = adapterFor(agent);
    // herdr can report a popup as idle; look at the screen before typing into it.
    const screen = await this.herdr.read(name, 'visible', 40).catch(() => '');
    for (const d of adapter.dialogs) {
      if (!d.pattern.test(screen)) continue;
      if (d.keys) {
        await this.herdr.sendKeys(name, d.keys);
        log(`${agent.slug}: dismissed ${d.name}`);
      } else if (!s.inflight) {
        this.escalate(agent, `shows "${d.name}"; answer it in the tab`);
        s.paused = true;
      }
      return; // re-check on the next tick
    }
    if (s.runsSinceReset >= this.company.config.heartbeat.rotateAfterRuns) {
      await this.herdr.prompt(name, adapter.resetCommand);
      s.runsSinceReset = 0;
      log(`${agent.slug}: context reset (${adapter.resetCommand})`);
      return;
    }
    const items = s.queue.splice(0, MAX_ITEMS_PER_WAKE);
    const runId = shortId('R');
    try {
      await this.herdr.prompt(name, wakeText(runId, items));
    } catch (err) {
      s.queue.unshift(...items);
      if ((err as FabrikError).code === 'agent_blocked') {
        this.escalate(agent, 'is blocked on a dialog; wake postponed');
        return;
      }
      throw err;
    }
    if (s.runsDate !== today()) { s.runsDate = today(); s.runsToday = 0; }
    s.runsToday++;
    s.runsSinceReset++;
    s.inflight = { runId, seqBefore: live.completion_seq ?? 0, startedAt: now, items, sawWorking: false, escalated: false };
    logRun(this.company, { run: runId, agent: agent.slug, outcome: 'started', items: items.map((i) => ({ key: i.key, reasons: i.reasons })) });
    log(`${agent.slug}: wake ${runId} -> ${items.map((i) => i.key).join(', ')}`);
  }

  async tick(): Promise<void> {
    const now = Date.now();
    let live: HerdrAgent[];
    try {
      live = await this.herdr.agents();
    } catch (err) {
      if (this.lastLiveCount !== -2) log(`herdr unavailable: ${(err as Error).message}`);
      this.lastLiveCount = -2;
      this.metadataApplied = false;
      return;
    }
    const ours = live.filter((a) => a.name && this.company.agents.some((x) => herdrName(this.company, x) === a.name));
    if (!this.metadataApplied || ours.length !== this.lastLiveCount) {
      // First contact or agents came back after a herdr restart: metadata does not survive restarts.
      await reapplyMetadata(this.company, this.herdr, live);
      this.metadataApplied = true;
      this.lastLiveCount = ours.length;
    }

    // Network and filesystem scans run outside the state lock; only the daemon writes these fields.
    const snapshot = loadState(this.company);
    const events: WakeEvent[] = [];
    if (this.plane && now - snapshot.plane.lastPoll >= (this.company.config.plane?.pollMs ?? 60_000)) {
      try {
        events.push(...(await this.pollPlane(snapshot)));
      } catch (err) {
        log(`plane poll failed: ${(err as Error).message}`);
        snapshot.plane.lastPoll = now; // back off until the next interval
      }
    }

    await withState(this.company, async (state) => {
      // `fabrik ask-human` may have registered questions since the snapshot was read.
      state.plane = { ...snapshot.plane, askHuman: { ...snapshot.plane.askHuman, ...state.plane.askHuman } };
      events.push(...this.inboxEvents(state), ...this.timerEvents(state, now), ...takeManualWakes(this.company));
      for (const ev of events) {
        const s = state.agents[ev.agent];
        if (!s) continue;
        enqueue(s.queue, ev, now);
        logEvent(this.company, { type: 'wake_queued', ...ev });
      }
      // herdr can drop an agent's name (seen after a codex /new); find it by pane and rename it.
      const located = new Map<string, HerdrAgent | undefined>();
      for (const agent of this.company.agents) {
        const s = state.agents[agent.slug]!;
        located.set(agent.slug, await locateAgent(this.herdr, this.company, agent, live, s.paneId).catch(() => undefined));
      }
      for (const agent of this.company.agents) {
        this.reconcile(agent, state.agents[agent.slug]!, located.get(agent.slug), now);
      }
      for (const agent of this.company.agents) {
        const s = state.agents[agent.slug]!;
        const l = located.get(agent.slug);
        const inflight = Object.values(state.agents).filter((x) => x.inflight).length;
        if (this.gate(agent, s, l, now, inflight) === null && l) {
          try {
            await this.deliver(agent, s, l, now);
          } catch (err) {
            log(`${agent.slug}: delivery failed: ${(err as Error).message}`);
          }
        }
        writeStatusCard(this.company, {
          slug: agent.slug, name: agent.name, title: agent.title, harness: agent.harness, model: agent.model,
          status: s.inflight ? `working (${s.inflight.runId})` : (l?.agent_status ?? 'offline'),
          queue: s.queue.map((q) => q.key), runsToday: s.runsDate === today() ? s.runsToday : 0,
          lastRun: s.lastRunEnd ? new Date(s.lastRunEnd).toISOString().slice(0, 16).replace('T', ' ') : '', paused: s.paused,
        });
      }
    });
  }

  async run(once = false): Promise<void> {
    takeLock(this.company);
    log(`daemon started for ${this.company.config.company.slug} (pid ${process.pid}, herdr session ${this.company.config.herdr.session})`);
    for (;;) {
      try {
        await this.tick();
      } catch (err) {
        log(`tick failed: ${(err as Error).stack ?? err}`);
      }
      if (once) return;
      await sleep(this.company.config.heartbeat.tickMs);
    }
  }
}
