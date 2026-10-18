import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { FabrikError, parseDuration } from './util.ts';

export const HARNESSES = ['claude', 'codex', 'grok', 'hermes'] as const;
export type Harness = (typeof HARNESSES)[number];
export const AUTONOMY = ['low', 'medium', 'high'] as const;
export type Autonomy = (typeof AUTONOMY)[number];

export const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const COMPANY_SLUG_RE = /^[a-z][a-z0-9-]{0,15}$/;

export interface AgentDef {
  name: string;
  slug: string;
  title: string;
  reportsTo: string | null;
  harness: Harness;
  model: string;
  effort: string | null;
  autonomy: Autonomy;
  enabled: boolean;
  timerMs: number | null;
  instructions: string;
  dir: string;
}

export interface CompanyConfig {
  company: { slug: string; name: string; human: string };
  herdr: { session: string; workspace: string; agentPrefix: string; startTimeoutMs: number };
  plane: {
    url: string;
    workspace: string;
    projects: string[];
    keyEnv: string;
    pollMs: number;
    maxRpm: number;
    agentLabelPrefix: string;
    humanLabel: string;
  } | null;
  obsidian: { vault: string; folder: string } | null;
  heartbeat: {
    tickMs: number;
    timerMs: number | null;
    maxConcurrent: number;
    maxRunsPerDay: number;
    cooldownMs: number;
    runTimeoutMs: number;
    rotateAfterRuns: number;
  };
  router: { unassigned: string };
  /** Let agents load the human's personal harness config (global AGENTS.md, Claude hooks and plugins). */
  inheritUserConfig: boolean;
}

export interface Company {
  root: string;
  stateDir: string;
  config: CompanyConfig;
  agents: AgentDef[];
}

export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = parseYaml(m[1] ?? '') ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new FabrikError('invalid_frontmatter', 'frontmatter must be a mapping');
  return { data: data as Record<string, unknown>, body: (m[2] ?? '').trim() };
}

/** Walk up from `start` to the directory holding fabrik.yaml. */
export function findCompanyRoot(start = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'fabrik.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function str(v: unknown, field: string, fallback?: string): string {
  if (v === undefined || v === null || v === '') {
    if (fallback !== undefined) return fallback;
    throw new FabrikError('invalid_config', `missing required field: ${field}`);
  }
  return String(v);
}

function num(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new FabrikError('invalid_config', `not a number: ${String(v)}`);
  return n;
}

function dur(v: unknown, fallback: string): number {
  return parseDuration((v ?? fallback) as string) ?? 0;
}

type Raw = Record<string, any>;

export function normalizeConfig(raw: Raw): CompanyConfig {
  const c = raw.company ?? {};
  const h = raw.herdr ?? {};
  const p = raw.plane;
  const o = raw.obsidian;
  const hb = raw.heartbeat ?? {};
  const slug = str(c.slug, 'company.slug');
  if (!COMPANY_SLUG_RE.test(slug)) throw new FabrikError('invalid_config', `company.slug must match ${COMPANY_SLUG_RE}`);
  return {
    company: { slug, name: str(c.name, 'company.name', slug), human: str(c.human, 'company.human', 'the human') },
    herdr: {
      session: str(h.session, 'herdr.session', 'default'),
      workspace: str(h.workspace, 'herdr.workspace', slug),
      agentPrefix: str(h.agent_prefix, 'herdr.agent_prefix', ''),
      startTimeoutMs: dur(h.start_timeout, '90s'),
    },
    plane: p
      ? {
          url: str(p.url, 'plane.url').replace(/\/+$/, ''),
          workspace: str(p.workspace, 'plane.workspace'),
          projects: Array.isArray(p.projects) ? p.projects.map(String) : [],
          keyEnv: str(p.key_env, 'plane.key_env', 'PLANE_API_KEY'),
          pollMs: dur(p.poll, '60s'),
          maxRpm: num(p.max_rpm, 30),
          agentLabelPrefix: str(p.labels?.agent_prefix, 'plane.labels.agent_prefix', 'agent:'),
          humanLabel: str(p.labels?.human, 'plane.labels.human', 'human'),
        }
      : null,
    obsidian: o ? { vault: str(o.vault, 'obsidian.vault'), folder: str(o.folder, 'obsidian.folder', 'Fabrik') } : null,
    heartbeat: {
      tickMs: dur(hb.tick, '10s'),
      timerMs: parseDuration(hb.timer ?? 'off'),
      maxConcurrent: num(hb.max_concurrent, 2),
      maxRunsPerDay: num(hb.max_runs_per_day, 20),
      cooldownMs: dur(hb.cooldown, '60s'),
      runTimeoutMs: dur(hb.run_timeout, '45m'),
      rotateAfterRuns: num(hb.rotate_after_runs, 15),
    },
    router: { unassigned: str(raw.router?.unassigned, 'router.unassigned', '') },
    inheritUserConfig: raw.inherit_user_config === true,
  };
}

export function normalizeAgent(data: Raw, body: string, dir: string): AgentDef {
  const slug = str(data.slug, 'slug');
  if (!AGENT_NAME_RE.test(slug)) throw new FabrikError('invalid_agent', `agent slug "${slug}" must match ${AGENT_NAME_RE}`);
  const harness = str(data.harness, `${slug}.harness`) as Harness;
  if (!HARNESSES.includes(harness)) throw new FabrikError('invalid_agent', `${slug}: unknown harness "${harness}" (${HARNESSES.join(', ')})`);
  const autonomy = str(data.autonomy, `${slug}.autonomy`, 'low') as Autonomy;
  if (!AUTONOMY.includes(autonomy)) throw new FabrikError('invalid_agent', `${slug}: autonomy must be low, medium or high`);
  const reports = data.reports_to ?? data.reportsTo ?? null;
  return {
    name: str(data.name, `${slug}.name`, slug),
    slug,
    title: str(data.title, `${slug}.title`),
    reportsTo: reports === null ? null : String(reports),
    harness,
    model: str(data.model, `${slug}.model`),
    effort: data.effort === undefined || data.effort === null ? null : String(data.effort),
    autonomy,
    enabled: data.enabled !== false,
    timerMs: parseDuration((data.heartbeat as Raw | undefined)?.timer ?? null),
    instructions: body,
    dir,
  };
}

export function validateCompany(company: Company): void {
  const slugs = new Set<string>();
  for (const a of company.agents) {
    if (slugs.has(a.slug)) throw new FabrikError('invalid_org', `duplicate agent slug: ${a.slug}`);
    slugs.add(a.slug);
    const full = company.config.herdr.agentPrefix + a.slug;
    if (!AGENT_NAME_RE.test(full)) throw new FabrikError('invalid_org', `herdr agent name "${full}" is too long or invalid`);
  }
  const roots = company.agents.filter((a) => a.reportsTo === null);
  if (company.agents.length > 0 && roots.length !== 1) {
    throw new FabrikError('invalid_org', `org must have exactly one top agent (reports_to: null); found ${roots.length}`);
  }
  for (const a of company.agents) {
    if (a.reportsTo !== null && !slugs.has(a.reportsTo)) throw new FabrikError('invalid_org', `${a.slug} reports to unknown agent ${a.reportsTo}`);
  }
  // Reporting lines must not loop.
  for (const a of company.agents) {
    const seen = new Set<string>();
    let cur: AgentDef | undefined = a;
    while (cur && cur.reportsTo !== null) {
      if (seen.has(cur.slug)) throw new FabrikError('invalid_org', `reporting loop at ${cur.slug}`);
      seen.add(cur.slug);
      cur = company.agents.find((x) => x.slug === cur!.reportsTo);
    }
  }
  const router = company.config.router.unassigned;
  if (router && !slugs.has(router)) throw new FabrikError('invalid_org', `router.unassigned names unknown agent ${router}`);
}

export function loadCompany(start = process.cwd()): Company {
  const root = findCompanyRoot(start);
  if (!root) throw new FabrikError('no_company', `no fabrik.yaml found in ${start} or its parents (run fabrik init)`);
  const config = normalizeConfig(parseYaml(readFileSync(join(root, 'fabrik.yaml'), 'utf8')) ?? {});
  const agentsDir = join(root, 'agents');
  const agents: AgentDef[] = [];
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir).sort()) {
      const dir = join(agentsDir, entry);
      const file = join(dir, 'AGENTS.md');
      if (!statSync(dir).isDirectory() || !existsSync(file)) continue;
      const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'));
      const agent = normalizeAgent(data, body, dir);
      if (agent.slug !== entry) throw new FabrikError('invalid_agent', `agents/${entry}/AGENTS.md has slug "${agent.slug}"; folder and slug must match`);
      agents.push(agent);
    }
  }
  const company: Company = { root, stateDir: join(root, '.fabrik'), config, agents };
  validateCompany(company);
  return company;
}

/** The agent whose directory contains `cwd`, if any. */
export function agentForCwd(company: Company, cwd = process.cwd()): AgentDef | null {
  const rel = relative(join(company.root, 'agents'), resolve(cwd));
  if (rel.startsWith('..') || rel === '') return null;
  const slug = rel.split(sep)[0];
  return company.agents.find((a) => a.slug === slug) ?? null;
}

export function herdrName(company: Company, agent: AgentDef): string {
  return company.config.herdr.agentPrefix + agent.slug;
}

export function tabLabel(agent: AgentDef): string {
  return `${agent.slug} · ${agent.title.toLowerCase()}`;
}

export function renderOrg(company: Company): string {
  const lines = [
    `# ${company.config.company.name} — org chart`,
    '',
    '<!-- generated by fabrik from agents/*/AGENTS.md; do not edit -->',
    '',
  ];
  const tree = (parent: string | null, depth: number): void => {
    for (const a of company.agents.filter((x) => x.reportsTo === parent)) {
      const off = a.enabled ? '' : ' (disabled)';
      lines.push(`${'  '.repeat(depth)}- **${a.name}** · ${a.title} — ${a.harness}/${a.model}, autonomy ${a.autonomy}${off}`);
      tree(a.slug, depth + 1);
    }
  };
  lines.push(`- **${company.config.company.human}** (human)`);
  tree(null, 1);
  lines.push('', '| slug | name | title | reports to | harness | model | effort | autonomy | timer |', '|---|---|---|---|---|---|---|---|---|');
  for (const a of company.agents) {
    const timer = a.timerMs === null ? 'off' : `${a.timerMs / 3_600_000}h`;
    lines.push(`| ${a.slug} | ${a.name} | ${a.title} | ${a.reportsTo ?? 'human'} | ${a.harness} | ${a.model} | ${a.effort ?? '-'} | ${a.autonomy} | ${timer} |`);
  }
  return lines.join('\n') + '\n';
}
