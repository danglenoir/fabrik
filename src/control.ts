import { herdrName } from './company.ts';
import type { Company } from './company.ts';
import { adapterFor } from './harness.ts';
import { Herdr } from './herdr.ts';
import { logRun, withState } from './state.ts';
import type { WakeItem } from './state.ts';
import { FabrikError } from './util.ts';

/** Added to work that a stop interrupted, so the next wake says where it came from. */
export const CONTINUE_REASON = 'continue after a stop';

/** Put interrupted items back at the front of the queue, merged with anything queued since. */
function requeue(queue: WakeItem[], items: WakeItem[]): void {
  for (const item of [...items].reverse()) {
    const reasons = item.reasons.includes(CONTINUE_REASON) ? [...item.reasons] : [...item.reasons, CONTINUE_REASON];
    const queued = queue.findIndex((q) => q.key === item.key);
    if (queued >= 0) {
      for (const r of queue[queued]!.reasons) if (!reasons.includes(r)) reasons.push(r);
      queue.splice(queued, 1);
    }
    queue.unshift({ ...item, reasons });
  }
}

/**
 * Stop an agent the way a human would: interrupt its current turn, pause it, and keep the
 * interrupted work at the front of its queue. The human can then talk to it in its tab;
 * `fabrik resume` lets the daemon continue with the queue.
 */
export async function stopAgent(company: Company, slug: string, herdr = new Herdr(company.config.herdr.session)): Promise<string> {
  const agent = company.agents.find((a) => a.slug === slug);
  if (!agent) throw new FabrikError('unknown_agent', `no agent "${slug}"`);
  const name = herdrName(company, agent);
  const live = await herdr.agent(name).catch(() => null);
  const busy = live?.agent_status === 'working' || live?.agent_status === 'blocked';
  if (busy) await herdr.sendKeys(name, adapterFor(agent).interruptKeys);
  const keys = await withState(company, (s) => {
    const a = s.agents[slug]!;
    a.paused = true;
    const run = a.inflight;
    if (!run) return [];
    a.inflight = null;
    a.lastRunEnd = Date.now();
    requeue(a.queue, run.items);
    logRun(company, { run: run.runId, agent: slug, outcome: 'stopped', items: run.items.map((i) => i.key) });
    return run.items.map((i) => i.key);
  });
  const what = busy ? 'interrupted and paused' : 'paused';
  const queued = keys.length ? `; ${keys.join(', ')} stays queued` : '';
  return `${slug} ${what}${queued}. Talk to it in its tab, then: fabrik resume ${slug}`;
}

export async function pauseAgent(company: Company, slug: string, paused: boolean): Promise<string> {
  const queued = await withState(company, (s) => {
    const a = s.agents[slug];
    if (!a) throw new FabrikError('unknown_agent', `no agent "${slug}"`);
    a.paused = paused;
    if (!paused) a.failures = 0;
    return a.queue.length;
  });
  if (paused) return `${slug} paused (its current turn, if any, finishes; use fabrik stop to interrupt it)`;
  return `${slug} resumed${queued ? `; ${queued} queued item${queued === 1 ? '' : 's'} will be delivered when it is idle` : ''}`;
}
