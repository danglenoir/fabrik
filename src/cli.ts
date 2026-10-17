#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { askHuman, inbox, note, requireAgent, runDone, taskClaim, taskComment, taskCreate, taskRelease, taskShow, taskState, whoami } from './agent.ts';
import { apply } from './apply.ts';
import { herdrName, loadCompany, renderOrg } from './company.ts';
import type { Company } from './company.ts';
import { Daemon, daemonPid, wakeDir } from './daemon.ts';
import { ADAPTERS } from './harness.ts';
import { Herdr } from './herdr.ts';
import { initCompany } from './init.ts';
import { doctor, installService, installShim, readSkill, registerCompany, registeredCompanies, serviceName, startupHook } from './ops.ts';
import { readSecrets, secretsPath, setSecret } from './secrets.ts';
import { loadState, withState } from './state.ts';
import { FabrikError, writeJson } from './util.ts';
import { join } from 'node:path';

const HELP = `fabrik — run an AI-agent company in herdr

Setup
  fabrik init --from proposal.yaml [--dir DIR] [--force]   create a company from an onboarding proposal
  fabrik apply [--dry-run] [--accept-trust] [--only a,b]  open tabs and start agents (idempotent)
  fabrik doctor                                           check herdr, harnesses, models, Plane, Obsidian
  fabrik secret set KEY  (value from stdin) | secret list
  fabrik service install                                  heartbeat daemon as a systemd --user service
  fabrik shim install                                     put \`fabrik\` on PATH (~/.local/bin)

Operate
  fabrik status | org | models [harness]
  fabrik wake <slug> [--reason TEXT] [--key KEY]
  fabrik pause <slug> | resume <slug>
  fabrik daemon [--once]

Agents (run from agents/<slug>/, or pass --as <slug>)
  fabrik whoami | inbox
  fabrik task show|claim|release <KEY>
  fabrik task comment <KEY> "<text>"
  fabrik task state <KEY> <todo|in_progress|in_review|done|blocked|cancelled>
  fabrik task create "<title>" [--assign SLUG] [--parent KEY] [--body TEXT] [--project ID]
  fabrik ask-human "<question>" [--task KEY]
  fabrik note "<text>"
  fabrik run done --summary "<text>"

  fabrik help heartbeat       the procedure agents follow on every wake
Global: --company DIR (default: nearest fabrik.yaml above the current directory)`;

const OPTIONS = {
  company: { type: 'string' }, from: { type: 'string' }, dir: { type: 'string' }, force: { type: 'boolean' },
  'dry-run': { type: 'boolean' }, 'accept-trust': { type: 'boolean' }, only: { type: 'string' }, once: { type: 'boolean' },
  reason: { type: 'string' }, key: { type: 'string' }, as: { type: 'string' }, assign: { type: 'string' }, parent: { type: 'string' },
  body: { type: 'string' }, project: { type: 'string' }, task: { type: 'string' }, summary: { type: 'string' },
  json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} as const;

function need(value: string | undefined, what: string): string {
  if (!value) throw new FabrikError('usage', `missing ${what} (see fabrik --help)`);
  return value;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    // Hidden prompt: raw mode, no echo, Enter submits.
    process.stderr.write('value (hidden): ');
    process.stdin.setRawMode(true);
    let value = '';
    for await (const chunk of process.stdin) {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); return value.trim(); }
        if (ch === '\u0003') { process.stdin.setRawMode(false); throw new FabrikError('aborted', 'aborted'); }
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    }
    return value.trim();
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function status(company: Company): Promise<string> {
  const state = loadState(company);
  let live: Awaited<ReturnType<Herdr['agents']>> = [];
  let herdrNote = '';
  try {
    live = await new Herdr(company.config.herdr.session).agents();
  } catch (err) {
    herdrNote = ` (herdr unreachable: ${(err as Error).message})`;
  }
  const pid = daemonPid(company);
  const lines = [`${company.config.company.name} — ${company.root}`, `daemon: ${pid ? `running (pid ${pid})` : 'not running'}${herdrNote}`, ''];
  lines.push('agent        title                status     runs  queue');
  for (const a of company.agents) {
    const s = state.agents[a.slug]!;
    const l = live.find((x) => x.name === herdrName(company, a));
    const st = !a.enabled ? 'disabled' : s.paused ? 'paused' : s.inflight ? 'running' : (l?.agent_status ?? 'offline');
    lines.push(`${a.slug.padEnd(12)} ${a.title.slice(0, 20).padEnd(20)} ${st.padEnd(10)} ${String(s.runsToday).padStart(4)}  ${s.queue.map((q) => q.key).join(', ') || '-'}`);
  }
  return lines.join('\n');
}

function sessionCompanies(): Company[] {
  const session = process.env.HERDR_SESSION || 'default';
  return registeredCompanies().filter((e) => e.session === session).flatMap((e) => {
    try { return [loadCompany(e.root)]; } catch { return []; }
  });
}

/** Plugin popup: live status of this session's companies until q / Esc / Ctrl-C. */
async function statusPane(): Promise<void> {
  let stop = false;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.on('data', (d) => { if (['q', '\u001b', '\u0003'].includes(String(d))) stop = true; });
  }
  while (!stop) {
    const companies = sessionCompanies();
    const text = companies.length ? (await Promise.all(companies.map(status))).join('\n\n') : 'No fabrik company is bound to this herdr session. Run fabrik init / fabrik apply.';
    process.stdout.write(`\u001b[2J\u001b[H${text}\n\n(q to close · refreshes every 5s)\n`);
    for (let i = 0; i < 50 && !stop; i++) await new Promise((r) => setTimeout(r, 100));
  }
  process.exit(0);
}

/** Plugin action: queue a wake for the fabrik agent in the focused pane. */
async function wakeFocused(): Promise<string> {
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) return 'fabrik: no focused pane';
  const live = await new Herdr(process.env.HERDR_SESSION || 'default').agents();
  const agent = live.find((a) => a.pane_id === pane);
  for (const c of sessionCompanies()) {
    const def = c.agents.find((a) => herdrName(c, a) === agent?.name);
    if (!def) continue;
    writeJson(join(wakeDir(c), `${Date.now()}-${def.slug}.json`), { agent: def.slug, key: 'manual', reason: 'manual wake from herdr' });
    await new Herdr(c.config.herdr.session).notify(`fabrik: wake queued for ${def.slug}`);
    return `queued a wake for ${def.slug}`;
  }
  return 'fabrik: the focused pane is not a fabrik agent';
}

async function main(argv: string[]): Promise<number> {
  const { values: o, positionals: p } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [cmd, sub, ...rest] = p;
  if (o.help || !cmd || cmd === 'help' && !sub) { console.log(HELP); return 0; }
  const out = (s: string) => console.log(s);
  const company = () => loadCompany(o.company ?? process.cwd());

  switch (cmd) {
    case 'help':
      if (sub === 'heartbeat') { out(readSkill('fabrik')); return 0; }
      if (sub === 'onboard') { out(readSkill('fabrik-onboard')); return 0; }
      out(HELP); return 0;

    case 'init': {
      const c = initCompany({ proposalPath: need(o.from, '--from proposal.yaml'), dir: o.dir, force: o.force });
      registerCompany(c);
      out(`created ${c.root} with ${c.agents.length} agents\nreview ${join(c.root, 'PROPOSAL.md')}, then: cd ${c.root} && fabrik doctor && fabrik apply`);
      return 0;
    }
    case 'apply': {
      const c = company();
      const r = await apply(c, { dryRun: o['dry-run'], acceptTrust: o['accept-trust'], only: o.only?.split(','), say: (s) => out(`· ${s}`) });
      if (!o['dry-run']) registerCompany(c);
      out(`started: ${r.started.join(', ') || '-'} · already running: ${r.existing.join(', ') || '-'}`);
      for (const s of r.skipped) out(`skipped ${s.agent}: ${s.reason}`);
      for (const n of r.needsAttention) out(`⚠ ${n.agent}: ${n.reason}`);
      for (const n of r.orphans) out(`⚠ ${n} runs in the company workspace but is not in the org (close its tab if unwanted)`);
      return r.needsAttention.length ? 1 : 0;
    }
    case 'doctor': {
      const checks = await doctor(company());
      for (const c of checks) out(`${{ ok: '✓', warn: '⚠', fail: '✗' }[c.level]} ${c.text}`);
      return checks.some((c) => c.level === 'fail') ? 1 : 0;
    }
    case 'secret': {
      const c = company();
      if (sub === 'set') { const path = setSecret(c, need(rest[0], 'KEY'), await readStdin()); out(`saved ${rest[0]} in ${path} (0600)`); return 0; }
      if (sub === 'list') { out(Object.keys(readSecrets(c)).join('\n') || `(no secrets in ${secretsPath(c)})`); return 0; }
      throw new FabrikError('usage', 'fabrik secret set KEY | secret list');
    }
    case 'service': {
      const c = company();
      if (sub === 'install') { out(`installed ${installService(c)}; status: systemctl --user status ${serviceName(c)}`); return 0; }
      throw new FabrikError('usage', 'fabrik service install');
    }
    case 'shim':
      if (sub === 'install') { out(`wrote ${installShim()}`); return 0; }
      throw new FabrikError('usage', 'fabrik shim install');
    case 'hook':
      if (sub === 'startup') { const done = await startupHook(); if (done.length) out(`fabrik: refreshed ${done.join(', ')}`); return 0; }
      if (sub === 'status-pane') { await statusPane(); return 0; }
      if (sub === 'wake-focused') { out(await wakeFocused()); return 0; }
      throw new FabrikError('usage', 'fabrik hook startup|status-pane|wake-focused');

    case 'status': out(await status(company())); return 0;
    case 'org': out(renderOrg(company())); return 0;
    case 'models': {
      for (const [h, a] of Object.entries(ADAPTERS)) {
        if (sub && sub !== h) continue;
        const m = a.supported ? await a.listModels() : null;
        out(`${h}: ${a.supported ? (m ? m.join(', ') : '(could not list)') : 'not supported yet'}`);
      }
      return 0;
    }
    case 'wake': {
      const c = company();
      const slug = need(sub, 'agent slug');
      if (!c.agents.some((a) => a.slug === slug)) throw new FabrikError('unknown_agent', `no agent "${slug}"`);
      writeJson(join(wakeDir(c), `${Date.now()}-${slug}.json`), { agent: slug, key: o.key ?? 'manual', reason: o.reason ?? 'manual wake' });
      out(daemonPid(c) ? `queued a wake for ${slug}` : `queued a wake for ${slug}, but the daemon is not running (fabrik daemon / fabrik service install)`);
      return 0;
    }
    case 'pause':
    case 'resume': {
      const c = company();
      const slug = need(sub, 'agent slug');
      await withState(c, (s) => {
        const a = s.agents[slug];
        if (!a) throw new FabrikError('unknown_agent', `no agent "${slug}"`);
        a.paused = cmd === 'pause';
        if (cmd === 'resume') a.failures = 0;
      });
      out(`${slug} ${cmd === 'pause' ? 'paused' : 'resumed'}`);
      return 0;
    }
    case 'daemon': await new Daemon(company()).run(o.once); return 0;

    case 'whoami': { const c = company(); out(whoami(c, requireAgent(c, o.as))); return 0; }
    case 'inbox': { const c = company(); out(await inbox(c, requireAgent(c, o.as))); return 0; }
    case 'task': {
      const c = company();
      if (sub === 'show') { out(await taskShow(c, need(rest[0], 'ticket key'))); return 0; }
      const me = requireAgent(c, o.as);
      if (sub === 'claim') { out(await taskClaim(c, me, need(rest[0], 'ticket key'))); return 0; }
      if (sub === 'release') { out(await taskRelease(c, me, need(rest[0], 'ticket key'))); return 0; }
      if (sub === 'comment') { out(await taskComment(c, me, need(rest[0], 'ticket key'), need(rest.slice(1).join(' '), 'comment text'))); return 0; }
      if (sub === 'state') { out(await taskState(c, me, need(rest[0], 'ticket key'), need(rest[1], 'state'))); return 0; }
      if (sub === 'create') { out(await taskCreate(c, me, need(rest.join(' '), 'title'), { assign: o.assign, parent: o.parent, body: o.body, project: o.project })); return 0; }
      throw new FabrikError('usage', 'fabrik task show|claim|release|comment|state|create');
    }
    case 'ask-human': { const c = company(); out(await askHuman(c, requireAgent(c, o.as), need([sub, ...rest].filter(Boolean).join(' '), 'question'), o.task)); return 0; }
    case 'note': { const c = company(); out(note(c, requireAgent(c, o.as), need([sub, ...rest].filter(Boolean).join(' '), 'text'))); return 0; }
    case 'run':
      if (sub === 'done') { const c = company(); out(runDone(c, requireAgent(c, o.as), need(o.summary ?? rest.join(' '), '--summary'))); return 0; }
      throw new FabrikError('usage', 'fabrik run done --summary "<text>"');
    case 'version': out(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version); return 0;
    default:
      throw new FabrikError('usage', `unknown command "${cmd}" (see fabrik --help)`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    const code = (err as FabrikError).code;
    console.error(`fabrik: ${err instanceof FabrikError || code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? err.message : (err as Error).stack}`);
    process.exit(code === 'usage' || code?.startsWith?.('ERR_PARSE_ARGS') ? 2 : code === 'claimed' ? 3 : 1);
  },
);
