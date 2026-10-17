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
  const humanLabel = company.config.plane?.humanLabel ?? 'human';

  for (const slug of now) {
    if (active && !before.includes(slug)) out.push({ agent: slug, key: issue.key, reason: 'assigned' });
  }
  if (prev && CLOSED.has(prev.stateGroup) && active) {
    for (const slug of now) out.push({ agent: slug, key: issue.key, reason: 'reopened' });
  }

  for (const c of newComments) {
    const author = commentAuthor(c);
    if (active) {
      for (const slug of now) {
        if (slug !== author) out.push({ agent: slug, key: issue.key, reason: author ? `comment from ${author}` : 'comment from a human' });
      }
    }
    for (const slug of mentions(company, c.text)) {
      if (slug !== author && !now.includes(slug)) out.push({ agent: slug, key: issue.key, reason: `mentioned by ${author ?? 'a human'}` });
    }
    const requester = ctx.askHuman[issue.id];
    if (requester && !author) out.push({ agent: requester, key: issue.key, reason: 'human answered' });
  }

  if (prev && !CLOSED.has(prev.stateGroup) && CLOSED.has(issue.stateGroup)) {
    const requester = ctx.askHuman[issue.id];
    if (requester) out.push({ agent: requester, key: issue.key, reason: 'human resolved your question' });
    if (issue.parent) {
      const siblings = Object.entries(ctx.snaps).filter(([id, s]) => s.parent === issue.parent && id !== issue.id);
      const parent = ctx.snaps[issue.parent];
      if (parent && siblings.every(([, s]) => CLOSED.has(s.stateGroup))) {
        for (const slug of assignedAgents(company, parent.labels)) out.push({ agent: slug, key: parent.key, reason: 'all sub-tasks done' });
      }
    }
  }

  const router = company.config.router.unassigned;
  if (!prev && active && router && now.length === 0 && !issue.labels.includes(humanLabel)) {
    out.push({ agent: router, key: issue.key, reason: 'new unassigned ticket to triage' });
  }
  return out;
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
  return `[fabrik wake run=${runId}] ${parts.join('; ')}. Run your fabrik heartbeat now (skill "fabrik", or: fabrik help heartbeat).`;
}
