import { randomBytes } from 'node:crypto';
import type { AgentDef, Company } from './company.ts';
import { loadState, logEvent, withState } from './state.ts';
import type { CompanyState } from './state.ts';
import { FabrikError, sleep } from './util.ts';

/**
 * Questions between agents. `fabrik ask <slug>` records a question; the daemon types it into the
 * colleague's herdr tab once the colleague is between runs, and the colleague replies with
 * `fabrik answer`. The CLI side only touches state.json, so it works inside harness sandboxes
 * that cannot reach the herdr socket, and the daemon keeps questions and wakes from colliding.
 */

export type AskStatus = 'pending' | 'delivered' | 'answered' | 'failed';

export interface Ask {
  id: string;
  /** Agent slug, or "human" for a question asked from a shell. */
  from: string;
  to: string;
  question: string;
  ticket: string | null;
  askedAt: number;
  status: AskStatus;
  deliveredAt: number | null;
  /** The colleague's completion_seq when the question was typed, and whether it was seen working since. */
  seqBefore: number;
  sawWorking: boolean;
  escalated: boolean;
  answer: string | null;
  /** "agent": with `fabrik answer`; "screen": copied from the tab because the colleague replied in its chat. */
  via: 'agent' | 'screen' | null;
  /** Why the question failed. */
  error: string | null;
  closedAt: number | null;
  /** The asker has read the answer. */
  collected: boolean;
  /** The answer was queued to the asker as a wake, because it had stopped waiting. */
  forwarded: boolean;
}

export const HUMAN = 'human';
export const MAX_QUESTION = 2000;
export const MAX_ANSWER = 4000;
/** A question the colleague had no time for in this long is dropped. */
export const PENDING_TTL_MS = 15 * 60_000;
/** An answer the asker has not picked up after this long reaches it as a wake. */
export const FORWARD_AFTER_MS = 30_000;
/** Closed questions are kept this long, for `fabrik ask --wait` and the hourly limit. */
const KEEP_MS = 24 * 3_600_000;

export function isOpen(ask: Ask): boolean {
  return ask.status === 'pending' || ask.status === 'delivered';
}

/** The open question `slug` is waiting for, if any. */
export function waitingOn(state: CompanyState, slug: string): Ask | undefined {
  return Object.values(state.asks).find((a) => a.from === slug && isOpen(a));
}

/** The question typed into `slug`'s tab that it has not answered yet, if any. */
export function answering(state: CompanyState, slug: string): Ask | undefined {
  return Object.values(state.asks).find((a) => a.to === slug && a.status === 'delivered');
}

/** Why `from` may not ask `to` right now, or null when it may. */
export function askRefusal(company: Company, state: CompanyState, from: string, to: string, now: number): string | null {
  const target = company.agents.find((a) => a.slug === to);
  if (!target) return `no agent "${to}"`;
  if (to === from) return 'you cannot ask yourself';
  if (!target.enabled) return `${to} is switched off`;
  if (state.agents[to]?.paused) return `${to} is paused while the human works with it; ask later, or comment on the ticket with @${to}`;
  const theirs = waitingOn(state, to);
  if (theirs?.to === from) return `${to} is waiting for your answer to ${theirs.id}; answer it first: fabrik answer ${theirs.id} "<answer>"`;
  if (theirs) return `${to} is waiting for an answer from ${theirs.to} itself; ask again in a few minutes`;
  if (from !== HUMAN) {
    const limit = company.config.heartbeat.maxAsksPerHour;
    if (limit === 0) return `questions between agents are switched off (heartbeat.max_asks_per_hour: 0); comment on the ticket with @${to} instead`;
    const recent = Object.values(state.asks).filter((a) => a.from === from && now - a.askedAt < 3_600_000).length;
    if (recent >= limit) return `you asked ${recent} questions in the last hour, the company's limit; comment on the ticket with @${to} instead`;
  }
  return null;
}

function newId(state: CompanyState): string {
  for (;;) {
    const id = `q-${randomBytes(2).toString('hex')}`;
    if (!state.asks[id]) return id;
  }
}

export async function createAsk(company: Company, from: AgentDef | null, to: string, question: string, ticket?: string): Promise<Ask> {
  const text = question.replace(/\s+/g, ' ').trim();
  if (!text) throw new FabrikError('usage', 'missing question');
  if (text.length > MAX_QUESTION) throw new FabrikError('too_long', `questions are limited to ${MAX_QUESTION} characters; put the details in a ticket or note and ask about that`);
  const asker = from?.slug ?? HUMAN;
  return withState(company, (state) => {
    const now = Date.now();
    const refusal = askRefusal(company, state, asker, to, now);
    if (refusal) throw new FabrikError('ask_refused', refusal);
    const ask: Ask = {
      id: newId(state), from: asker, to, question: text, ticket: ticket?.toUpperCase() ?? null, askedAt: now, status: 'pending',
      deliveredAt: null, seqBefore: 0, sawWorking: false, escalated: false, answer: null, via: null, error: null, closedAt: null,
      collected: false, forwarded: false,
    };
    state.asks[ask.id] = ask;
    logEvent(company, { type: 'ask', id: ask.id, from: asker, to, ticket: ask.ticket });
    return ask;
  });
}

export function settleAsk(ask: Ask, answer: string, via: 'agent' | 'screen', now: number): void {
  ask.status = 'answered';
  ask.answer = answer;
  ask.via = via;
  ask.closedAt = now;
}

export function failAsk(ask: Ask, error: string, now: number): void {
  ask.status = 'failed';
  ask.error = error;
  ask.closedAt = now;
}

/** `fabrik answer`: record the colleague's reply. `by` is null for the human answering from a shell. */
export async function answerAsk(company: Company, by: AgentDef | null, id: string, text: string): Promise<string> {
  const answer = text.trim();
  if (!answer) throw new FabrikError('usage', 'missing answer');
  if (answer.length > MAX_ANSWER) throw new FabrikError('too_long', `answers are limited to ${MAX_ANSWER} characters; summarize, or write the details to a note and give its path`);
  return withState(company, (state) => {
    const ask = state.asks[id.toLowerCase()];
    if (!ask) throw new FabrikError('unknown_question', `no question ${id} (questions are kept for a day)`);
    if (by && by.slug !== ask.to) throw new FabrikError('not_yours', `${ask.id} was asked to ${ask.to}, not to you`);
    if (ask.status === 'answered') throw new FabrikError('answered', `${ask.id} is already answered`);
    // A late answer to a question the asker saw fail still reaches it, as a wake.
    if (ask.status === 'failed') ask.collected = false;
    settleAsk(ask, answer, 'agent', Date.now());
    logEvent(company, { type: 'answered', id: ask.id, from: ask.from, to: ask.to, via: 'agent' });
    return `answered ${ask.id}; ${ask.from === HUMAN ? 'the human' : ask.from} gets it now`;
  });
}

/**
 * Wait until the question is answered or failed, or `timeoutMs` passes. An answer read here is
 * marked collected, so it is not delivered to the asker again as a wake.
 */
export async function awaitAnswer(company: Company, id: string, timeoutMs: number, pollMs = 1000): Promise<Ask> {
  const key = id.toLowerCase();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ask = loadState(company).asks[key];
    if (!ask) throw new FabrikError('unknown_question', `no question ${id} (questions are kept for a day)`);
    if (!isOpen(ask)) {
      return withState(company, (state) => {
        const a = state.asks[key] ?? ask;
        a.collected = true;
        return a;
      });
    }
    if (Date.now() >= deadline) return ask;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/** What the colleague sees in its tab. One line: the harness gets it as a single prompt. */
export function askText(company: Company, ask: Ask): string {
  const asker = company.agents.find((a) => a.slug === ask.from);
  const who = asker ? `${asker.name} (${asker.slug}, ${asker.title})` : `${company.config.company.human} (the human)`;
  const about = ask.ticket ? `, about ${ask.ticket}` : '';
  return `[fabrik question ${ask.id} from ${who}${about}] ${ask.question} ` +
    `— Answer in a few sentences from what you know or can quickly look up, with: fabrik answer ${ask.id} "<answer>". ` +
    `${asker ? asker.slug : 'The human'} is waiting for it. This is not a wake: do not start other work, claim tickets or run fabrik run done for it. ` +
    'If answering needs real work, say so in your answer and suggest a ticket.';
}

/** The colleague's reply as its tab shows it, for when it answered in its chat instead of with `fabrik answer`. */
export function replyFromScreen(screen: string, id: string): string | null {
  const marker = `[fabrik question ${id} `;
  const at = screen.lastIndexOf(marker);
  if (at < 0) return null;
  const lines = screen.slice(at).split('\n').slice(1).map((l) => l.trimEnd());
  // The harness's input box and prompt glyphs below the reply carry no words.
  while (lines.length && !/[\p{L}\p{N}]/u.test(lines.at(-1)!)) lines.pop();
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return null;
  return text.length > MAX_ANSWER ? `…${text.slice(-MAX_ANSWER)}` : text;
}

/** Fail questions nobody could deliver in time and forget closed ones after a day. */
export function pruneAsks(company: Company, state: CompanyState, now: number): void {
  for (const ask of Object.values(state.asks)) {
    if (now - ask.askedAt > KEEP_MS) { delete state.asks[ask.id]; continue; }
    if (ask.status === 'pending' && now - ask.askedAt > PENDING_TTL_MS) {
      failAsk(ask, `${ask.to} had no time for it in ${PENDING_TTL_MS / 60_000} minutes`, now);
      logEvent(company, { type: 'ask_failed', id: ask.id, error: ask.error });
    }
  }
}

/** Status line for an open question, as the asker sees it while waiting. */
export function askProgress(ask: Ask): string {
  if (ask.status === 'pending') return `${ask.to} gets the question as soon as it is between runs`;
  return `${ask.to} is answering`;
}
