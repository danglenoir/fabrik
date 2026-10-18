import { herdrName, loadCompany } from './company.ts';
import type { Company } from './company.ts';
import { daemonPid } from './daemon.ts';
import { Herdr } from './herdr.ts';
import type { HerdrAgent } from './herdr.ts';
import { registeredCompanies } from './ops.ts';
import { loadState } from './state.ts';
import { today } from './util.ts';

export interface AgentRow { slug: string; title: string; status: string; runsToday: number; queue: string[] }
export interface CompanyStatus { name: string; slug: string; root: string; daemon: number | null; herdrError: string | null; agents: AgentRow[] }

export async function companyStatus(company: Company): Promise<CompanyStatus> {
  const state = loadState(company);
  let live: HerdrAgent[] = [];
  let herdrError: string | null = null;
  try {
    live = await new Herdr(company.config.herdr.session).agents();
  } catch (err) {
    herdrError = (err as Error).message;
  }
  const agents = company.agents.map((a) => {
    const s = state.agents[a.slug]!;
    const l = live.find((x) => x.name === herdrName(company, a)) ?? live.find((x) => x.pane_id === s.paneId && !x.name);
    const status = !a.enabled ? 'disabled' : s.paused ? 'paused' : s.inflight ? 'running' : (l?.agent_status ?? 'offline');
    return { slug: a.slug, title: a.title, status, runsToday: s.runsDate === today() ? s.runsToday : 0, queue: s.queue.map((q) => q.key) };
  });
  return { name: company.config.company.name, slug: company.config.company.slug, root: company.root, daemon: daemonPid(company), herdrError, agents };
}

/** `fabrik status`: a plain table for the terminal and for scripts. */
export function renderTable(st: CompanyStatus): string {
  const lines = [
    `${st.name} — ${st.root}`,
    `daemon: ${st.daemon ? `running (pid ${st.daemon})` : 'not running'}${st.herdrError ? ` (herdr unreachable: ${st.herdrError})` : ''}`,
    '',
    'agent        title                status     runs  queue',
  ];
  for (const a of st.agents) {
    lines.push(`${a.slug.padEnd(12)} ${a.title.slice(0, 20).padEnd(20)} ${a.status.padEnd(10)} ${String(a.runsToday).padStart(4)}  ${a.queue.join(', ') || '-'}`);
  }
  return lines.join('\n');
}

// The popup uses only the terminal's default colours, bold/dim and the 16 ANSI palette colours,
// which herdr maps to the active theme. No RGB values: the popup follows any herdr theme.
const sgr = (code: string) => (text: string) => `\u001b[${code}m${text}\u001b[0m`;
const bold = sgr('1');
const dim = sgr('2');
const STATUS_COLOUR: Record<string, (t: string) => string> = {
  working: sgr('32'), running: sgr('32'), blocked: sgr('33'), paused: sgr('31'), offline: sgr('31'),
};

function fit(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width);
}

/** The plugin popup: one header line per company, one line per agent, key hints in the footer. */
export function renderCompact(companies: CompanyStatus[], width: number, height: number): string[] {
  const out: string[] = [];
  if (companies.length === 0) return [dim(fit('No fabrik company in this herdr session. Run fabrik init, then fabrik apply.', width))];
  const slugW = Math.max(4, ...companies.flatMap((c) => c.agents.map((a) => a.slug.length)));
  const titleW = Math.min(14, Math.max(5, ...companies.flatMap((c) => c.agents.map((a) => a.title.length))));
  for (const [i, c] of companies.entries()) {
    if (i > 0) out.push('');
    const daemon = c.daemon ? sgr('32')('daemon running') : sgr('31')('daemon stopped');
    const herdr = c.herdrError ? ` ${sgr('31')('herdr unreachable')}` : '';
    const nameW = Math.max(0, width - 'daemon running'.length - (c.herdrError ? 18 : 0) - 1);
    out.push(`${bold(fit(c.name, nameW))} ${daemon}${herdr}`);
    for (const a of c.agents) {
      const colour = STATUS_COLOUR[a.status] ?? ((t: string) => t);
      const runs = `${a.runsToday} run${a.runsToday === 1 ? '' : 's'}`;
      const fixed = `${fit(a.slug, slugW)}  ${fit(a.title, titleW)}  `;
      const queueW = Math.max(0, width - fixed.length - 10 - 8 - 2);
      out.push(`${fixed}${colour(fit(a.status, 10))}${dim(fit(runs, 8))}  ${fit(a.queue.join(', ') || '-', queueW)}`);
    }
  }
  const footer = dim(fit('q close · refreshes every 5 s', width));
  const room = Math.max(1, height - 2);
  if (out.length > room) {
    const hidden = out.length - (room - 1);
    out.splice(room - 1, out.length, dim(`… ${hidden} more line${hidden === 1 ? '' : 's'}; run fabrik status`));
  }
  return [...out, '', footer];
}

export function sessionCompanies(): Company[] {
  const session = process.env.HERDR_SESSION || 'default';
  return registeredCompanies().filter((e) => e.session === session).flatMap((e) => {
    try { return [loadCompany(e.root)]; } catch { return []; }
  });
}

/** Run the popup until q, Esc or Ctrl-C. Redraws in place instead of clearing the screen. */
export async function statusPane(): Promise<void> {
  let stop = false;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.on('data', (d) => { if (['q', '\u001b', '\u0003'].includes(String(d))) stop = true; });
  }
  process.stdout.write('\u001b[?25l'); // hide the cursor
  try {
    while (!stop) {
      const statuses = await Promise.all(sessionCompanies().map(companyStatus));
      const lines = renderCompact(statuses, process.stdout.columns || 72, process.stdout.rows || 14);
      process.stdout.write(`\u001b[H${lines.map((l) => `${l}\u001b[K`).join('\r\n')}\u001b[J`);
      for (let i = 0; i < 50 && !stop; i++) await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    process.stdout.write('\u001b[0m\u001b[?25h');
  }
}
