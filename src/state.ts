import { join } from 'node:path';
import type { Company } from './company.ts';
import { FabrikError, readJson, writeJson, appendJsonl, withFileLock } from './util.ts';

export interface WakeItem {
  key: string; // coalescing key: issue identifier, note path, "manual", "timer"
  reasons: string[];
  firstAt: number;
  lastAt: number;
}

export interface InflightRun {
  runId: string;
  seqBefore: number;
  startedAt: number;
  items: WakeItem[];
  sawWorking: boolean;
  escalated: boolean;
}

export interface AgentState {
  paneId: string | null;
  tabId: string | null;
  introduced: boolean;
  paused: boolean;
  runsDate: string;
  runsToday: number;
  runsSinceReset: number;
  failures: number;
  lastRunEnd: number;
  lastTimerCheck: number;
  inflight: InflightRun | null;
  queue: WakeItem[];
}

export interface IssueSnap {
  key: string;
  labels: string[];
  stateGroup: string;
  parent: string | null;
  updatedAt: string;
}

export interface CompanyState {
  version: 1;
  workspaceId: string | null;
  agents: Record<string, AgentState>;
  plane: {
    hwm: string | null;
    lastPoll: number;
    snaps: Record<string, IssueSnap>; // by issue id
    seenComments: Record<string, string[]>; // issue id -> comment ids
    askHuman: Record<string, string>; // issue id -> requesting agent slug
  };
  inbox: Record<string, number>; // note path -> mtimeMs processed
}

export function emptyAgentState(): AgentState {
  return {
    paneId: null, tabId: null, introduced: false, paused: false, runsDate: '', runsToday: 0,
    runsSinceReset: 0, failures: 0, lastRunEnd: 0, lastTimerCheck: 0, inflight: null, queue: [],
  };
}

export function statePath(company: Company): string {
  return join(company.stateDir, 'state.json');
}

export function loadState(company: Company): CompanyState {
  const s = readJson<CompanyState>(statePath(company), {
    version: 1, workspaceId: null, agents: {}, plane: { hwm: null, lastPoll: 0, snaps: {}, seenComments: {}, askHuman: {} }, inbox: {},
  });
  for (const a of company.agents) s.agents[a.slug] = { ...emptyAgentState(), ...s.agents[a.slug] };
  s.plane.askHuman ??= {};
  return s;
}

export function saveState(company: Company, state: CompanyState): void {
  writeJson(statePath(company), state);
}

/**
 * Load, mutate and save state under an exclusive lock file. The daemon and the CLI
 * (`fabrik apply`, `fabrik pause`, …) both write state.json; the lock stops lost updates.
 */
export async function withState<T>(company: Company, fn: (state: CompanyState) => T | Promise<T>): Promise<T> {
  const lock = join(company.stateDir, 'state.lock');
  try {
    return await withFileLock(lock, async () => {
      const state = loadState(company);
      const result = await fn(state);
      saveState(company, state);
      return result;
    });
  } catch (err) {
    if ((err as FabrikError).code === 'locked') throw new FabrikError('state_locked', `state is locked (${lock}); is another fabrik command stuck?`);
    throw err;
  }
}

/** Where `fabrik run done` leaves the agent's report for the daemon. */
export function reportPath(company: Company, slug: string): string {
  return join(company.stateDir, 'reports', `${slug}.json`);
}

export function logRun(company: Company, record: Record<string, unknown>): void {
  appendJsonl(join(company.stateDir, 'runs.jsonl'), { at: new Date().toISOString(), ...record });
}

export function logEvent(company: Company, record: Record<string, unknown>): void {
  appendJsonl(join(company.stateDir, 'events.jsonl'), { at: new Date().toISOString(), ...record });
}
