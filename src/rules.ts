import type { Company } from './company.ts';
import type { PlaneComment, PlaneIssue } from './plane.ts';
import { COMMENT_SIGNATURE_RE } from './plane.ts';
import type { IssueSnap, WakeItem } from './state.ts';

export interface WakeEvent {
  agent: string;
  key: string;
  reason: string;
}

const ACTIVE = new Set(['unstarted', 'started']);
const CLOSED = new Set(['completed', 'cancelled']);

export function assignedAgents(company: Company, labels: string[]): string[] {
  const prefix = company.config.plane?.agentLabelPrefix ?? 'agent:';
  const slugs = new Set(company.agents.map((a) => a.slug));
  return labels.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length)).filter((s) => slugs.has(s));
}

export function commentAuthor(c: PlaneComment): string | null {
  return COMMENT_SIGNATURE_RE.exec(c.text)?.[1] ?? null;
}

export function mentions(company: Company, text: string): string[] {
  const found = new Set<string>();
  for (const a of company.agents) {
    if (new RegExp(`(^|[^\\w@])@${a.slug}\\b`).test(text)) found.add(a.slug);
  }
  return [...found];
}

export interface DiffContext {
  snaps: Record<string, IssueSnap>;
  askHuman: Record<string, string>;
  claims?: Record<string, string>; // ticket key -> agent holding the claim
}

/**
 * Wake events for one changed Plane issue. `prev` is undefined for an issue fabrik has not
 * seen before; callers skip events entirely on the very first poll (bootstrap).
 */
export function diffIssue(company: Company, prev: IssueSnap | undefined, issue: PlaneIssue, newComments: PlaneComment[], ctx: DiffContext): WakeEvent[] {
  const out: WakeEvent[] = [];
  const now = assignedAgents(company, issue.labels);
  const before = prev ? assignedAgents(company, prev.labels) : [];
  const active = ACTIVE.has(issue.stateGroup);
  // Plane creates tickets in Backlog by default; moving one out of it is when it becomes ready.
  const activated = !!prev && active && !ACTIVE.has(prev.stateGroup) && !CLOSED.has(prev.stateGroup);
  const humanLabel = company.config.plane?.humanLabel ?? 'human';
  const isHumanTicket = issue.labels.includes(humanLabel);

  for (const slug of now) {
    if (active && (activated || !before.includes(slug))) out.push({ agent: slug, key: issue.key, reason: 'assigned' });
  }
  if (prev && CLOSED.has(prev.stateGroup) && active) {
    for (const slug of now) out.push({ agent: slug, key: issue.key, reason: 'reopened' });
  }

  // Whoever claimed the ticket follows its comments too, labelled or not.
  const claimant = ctx.claims?.[issue.key];
  const followers = claimant && !now.includes(claimant) ? [...now, claimant] : now;
  for (const c of newComments) {
    const author = commentAuthor(c);
    if (active) {
      for (const slug of followers) {
        if (slug !== author) out.push({ agent: slug, key: issue.key, reason: author ? `comment from ${author}` : 'comment from a human' });
      }
    }
    for (const slug of mentions(company, c.text)) {
      if (slug !== author && !followers.includes(slug)) out.push({ agent: slug, key: issue.key, reason: `mentioned by ${author ?? 'a human'}` });
    }
    const requester = ctx.askHuman[issue.id];
    if (requester && !author) out.push({ agent: requester, key: issue.key, reason: 'human answered' });
  }

  if (prev && !CLOSED.has(prev.stateGroup) && CLOSED.has(issue.stateGroup)) {
    const requester = ctx.askHuman[issue.id];
    if (requester) out.push({ agent: requester, key: issue.key, reason: 'human resolved your question' });
    // Questions to the human hang off the task they are about, but they are not sub-tasks.
    if (issue.parent && !isHumanTicket) {
      const parent = ctx.snaps[issue.parent];
      const siblings = Object.entries(ctx.snaps).filter(([id, s]) => s.parent === issue.parent && id !== issue.id && !s.labels.includes(humanLabel));
      if (parent && !CLOSED.has(parent.stateGroup) && siblings.every(([, s]) => CLOSED.has(s.stateGroup))) {
        for (const slug of assignedAgents(company, parent.labels)) out.push({ agent: slug, key: parent.key, reason: 'all sub-tasks done' });
      }
    }
  }

  const router = company.config.router.unassigned;
  if ((!prev || activated) && active && router && now.length === 0 && !isHumanTicket) {
    out.push({ agent: router, key: issue.key, reason: 'new unassigned ticket to triage' });
  }
  return out;
}

/** True for wakes caused by another agent's comment or @mention (as opposed to a human). */
export function causedByAgent(reason: string): boolean {
  return /^(comment from|mentioned by) (?!a human$)/.test(reason);
}

export const AGENT_WAKES_PER_TICKET_PER_HOUR = 4;

/**
 * Loop guard: two agents that answer each other on one ticket would wake each other until the
 * daily cap. Allow at most `limit` agent-caused wakes per ticket per hour; `history` (ticket key
 * -> timestamps) is updated in place. Wakes caused by humans are never limited.
 */
export function limitAgentChatter(events: WakeEvent[], history: Record<string, number[]>, now: number, limit = AGENT_WAKES_PER_TICKET_PER_HOUR): { kept: WakeEvent[]; dropped: WakeEvent[] } {
  for (const [key, times] of Object.entries(history)) {
    const recent = times.filter((t) => now - t < 3_600_000);
    if (recent.length) history[key] = recent;
    else delete history[key];
  }
  const kept: WakeEvent[] = [];
  const dropped: WakeEvent[] = [];
  for (const ev of events) {
    if (!causedByAgent(ev.reason)) { kept.push(ev); continue; }
    const times = (history[ev.key] ??= []);
    if (times.length >= limit) { dropped.push(ev); continue; }
    times.push(now);
    kept.push(ev);
  }
  return { kept, dropped };
}

/** Merge an event into an agent queue, coalescing by key. */
export function enqueue(queue: WakeItem[], ev: WakeEvent, now: number): void {
  const item = queue.find((q) => q.key === ev.key);
  if (item) {
    if (!item.reasons.includes(ev.reason)) item.reasons.push(ev.reason);
    item.lastAt = now;
  } else {
    queue.push({ key: ev.key, reasons: [ev.reason], firstAt: now, lastAt: now });
  }
}

export function wakeText(runId: string, items: WakeItem[]): string {
  const parts = items.map((i) => `${i.key}: ${i.reasons.join(', ')}`);
  const mentioned = items.some((i) => i.reasons.some((r) => r.startsWith('mentioned by')));
  const hint = mentioned ? ' Where you were only mentioned, the ticket belongs to someone else: answer what you were asked there and do not take over its work.' : '';
  return `[fabrik wake run=${runId}] ${parts.join('; ')}.${hint} Run your fabrik heartbeat now (skill "fabrik", or: fabrik help heartbeat).`;
}
