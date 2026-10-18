import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { effectiveAutonomy, loadCompany } from './company.ts';
import type { Company } from './company.ts';
import { daemonPid } from './daemon.ts';
import { ADAPTERS, adapterFor } from './harness.ts';
import { Herdr } from './herdr.ts';
import { codexHome, codexHomeLinks } from './isolation.ts';
import { fabrikFolder } from './obsidian.ts';
import { reapplyMetadata } from './apply.ts';
import { Plane, PlaneHttpError } from './plane.ts';
import { getSecret } from './secrets.ts';
import { fabrikConfigDir, readJson, writeFileAtomic, writeJson } from './util.ts';

export const FABRIK_ROOT = resolve(import.meta.dirname, '..');

const configDir = fabrikConfigDir;

// ---------- company registry (used by the herdr startup hook) ----------

interface RegistryEntry { slug: string; root: string; session: string }

export function registerCompany(company: Company): void {
  const path = join(configDir(), 'companies.json');
  const list = readJson<RegistryEntry[]>(path, []).filter((e) => e.root !== company.root);
  list.push({ slug: company.config.company.slug, root: company.root, session: company.config.herdr.session });
  writeJson(path, list);
}

export function registeredCompanies(): RegistryEntry[] {
  return readJson<RegistryEntry[]>(join(configDir(), 'companies.json'), []);
}

/**
 * herdr [[startup]] hook: runs once per server start in every session. Re-applies agent
 * metadata (herdr does not persist it) for companies bound to this session, then exits.
 */
export async function startupHook(): Promise<string[]> {
  const session = process.env.HERDR_SESSION || 'default';
  const done: string[] = [];
  if (process.env.HERDR_PLUGIN_ROOT) writeFileAtomic(join(configDir(), 'plugin-root'), process.env.HERDR_PLUGIN_ROOT + '\n');
  for (const entry of registeredCompanies().filter((e) => e.session === session)) {
    try {
      const company = loadCompany(entry.root);
      // The startup hook runs before agents finish resuming; retry a few times.
      for (let i = 0; i < 6; i++) {
        const n = await reapplyMetadata(company, new Herdr(session));
        if (n >= company.agents.filter((a) => a.enabled).length) break;
        await new Promise((r) => setTimeout(r, 5000));
      }
      done.push(entry.slug);
    } catch { /* a moved or broken company must not break herdr startup */ }
  }
  return done;
}

// ---------- CLI shim ----------

export function shimScript(): string {
  return `#!/bin/sh
# fabrik CLI shim (written by \`fabrik shim install\`). Finds the fabrik plugin and runs its launcher,
# which picks a Node.js >= 24.
root=$(cat "\${FABRIK_CONFIG_DIR:-\${XDG_CONFIG_HOME:-$HOME/.config}/fabrik}/plugin-root" 2>/dev/null)
if [ ! -f "$root/bin/fabrik" ]; then
  root=$(herdr plugin list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const l=j.plugins??j.result?.plugins??j;const p=l.find(x=>x.plugin_id==="fabrik"||x.id==="fabrik");if(p)console.log(p.plugin_root)}catch{}})')
fi
[ -f "$root/bin/fabrik" ] || root=${JSON.stringify(FABRIK_ROOT)}
exec sh "$root/bin/fabrik" "$@"
`;
}

/** The Node.js recorded by `fabrik shim install`; bin/fabrik prefers it over whatever is on PATH. */
export function pinnedNode(): string | null {
  try {
    return readFileSync(join(configDir(), 'node'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function installShim(): string {
  const bin = join(homedir(), '.local', 'bin', 'fabrik');
  writeFileAtomic(join(configDir(), 'plugin-root'), FABRIK_ROOT + '\n');
  writeFileAtomic(join(configDir(), 'node'), process.execPath + '\n');
  writeFileAtomic(bin, shimScript(), 0o755);
  return bin;
}

// ---------- systemd --user service ----------

export function serviceName(company: Company): string {
  return `fabrik-${company.config.company.slug}.service`;
}

export function serviceUnit(company: Company): string {
  return `[Unit]
Description=fabrik heartbeat for ${company.config.company.name}
After=default.target

[Service]
Type=simple
ExecStart=${process.execPath} ${join(FABRIK_ROOT, 'src', 'cli.ts')} daemon --company ${company.root}
Restart=on-failure
RestartSec=15
Environment=PATH=${process.env.PATH ?? '/usr/bin:/bin'}

[Install]
WantedBy=default.target
`;
}

export function installService(company: Company, start = true): string {
  const path = join(homedir(), '.config', 'systemd', 'user', serviceName(company));
  writeFileAtomic(path, serviceUnit(company));
  execFileSync('systemctl', ['--user', 'daemon-reload']);
  if (start) execFileSync('systemctl', ['--user', 'enable', '--now', serviceName(company)]);
  return path;
}

// ---------- doctor ----------

export interface Check { level: 'ok' | 'warn' | 'fail'; text: string }

function which(cmd: string): string | null {
  try {
    return execFileSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((r) => execFile(cmd, args, { timeout: 20_000 }, (_e, out, err) => r(String(out || err || ''))));
}

export async function doctor(company: Company): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (level: Check['level'], text: string) => checks.push({ level, text });

  // herdr plugin commands go through bin/fabrik, which prefers the pinned Node over herdr's PATH.
  const pinned = pinnedNode();
  let nodeVersion = process.versions.node;
  if (pinned) {
    try { nodeVersion = execFileSync(pinned, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim(); } catch { nodeVersion = 'missing'; }
  }
  const major = Number(nodeVersion.split('.')[0]);
  if (!(major >= 24)) add('fail', `node ${nodeVersion} at ${pinned ?? process.execPath}: fabrik needs Node.js >= 24; run fabrik shim install with Node 24`);
  else if (!pinned) add('warn', `node ${nodeVersion}, but no Node is pinned for herdr plugin commands; run: fabrik shim install`);
  else add('ok', `node ${nodeVersion} pinned for fabrik and its herdr plugin commands (${pinned})`);

  const herdr = new Herdr(company.config.herdr.session);
  try {
    await herdr.agents();
    add('ok', `herdr session "${company.config.herdr.session}" reachable`);
  } catch (err) {
    add('fail', `herdr session "${company.config.herdr.session}" not reachable: ${(err as Error).message}`);
  }

  const integrations = await run(herdr.bin, ['integration', 'status']);
  for (const harness of new Set(company.agents.filter((a) => a.enabled).map((a) => a.harness))) {
    const adapter = ADAPTERS[harness];
    if (!adapter.supported) { add('warn', `${harness}: not supported in fabrik v0.1; its agents are skipped`); continue; }
    add(which(harness) ? 'ok' : 'fail', `${harness} binary ${which(harness) ?? 'not found on PATH'}`);
    const line = integrations.split('\n').find((l) => l.startsWith(`${harness}:`)) ?? '';
    if (/current/.test(line)) add('ok', `herdr ${harness} integration current`);
    else add('warn', `herdr ${harness} integration ${line.split(':')[1]?.trim() || 'unknown'}; run: herdr integration install ${harness}`);
  }

  for (const a of company.agents.filter((x) => x.enabled && adapterFor(x).supported)) {
    const models = await adapterFor(a).listModels();
    const ok = models === null || models.includes(a.model) || (a.harness === 'claude' && a.model.startsWith('claude-'));
    add(ok ? 'ok' : 'fail', `${a.slug}: model ${a.harness}/${a.model}${ok ? '' : ` not offered (have: ${models!.join(', ')})`}`);
    if (effectiveAutonomy(company, a) === 'high') add('warn', `${a.slug}: autonomy high runs without permission prompts`);
  }

  const uses = (h: string) => company.agents.some((a) => a.enabled && a.harness === h);
  const isolate = company.config.isolate;
  if (existsSync(join(homedir(), 'AGENTS.md'))) {
    const shim = existsSync(join(company.root, 'CLAUDE.md'));
    add(shim ? 'ok' : 'warn', shim ? '~/AGENTS.md is kept out of Claude agents by the company CLAUDE.md' : '~/AGENTS.md will reach Claude agents (company CLAUDE.md missing)');
  }
  if (uses('claude')) {
    add('ok', isolate ? 'Claude agents run without your personal Claude Code settings, hooks, plugins and skills (isolate: true)' : 'Claude agents use your Claude Code setup: skills, memory, hooks, plugins');
  }
  if (uses('codex')) {
    if (!existsSync(codexHome(company))) add('warn', `Codex agents need their CODEX_HOME; run fabrik apply to create ${codexHome(company)}`);
    else if (existsSync(join(codexHome(company), 'auth.json')) && !codexHomeLinks(company, 'auth.json')) add('warn', `${join(codexHome(company), 'auth.json')} is a copy, not a link to your Codex login; delete it and run fabrik apply`);
    else add('ok', `Codex agents use your ~/.codex without its global AGENTS.md (${codexHome(company)})`);
  }

  const p = company.config.plane;
  if (p) {
    const key = getSecret(company, p.keyEnv);
    if (!key) add('fail', `Plane key missing: fabrik secret set ${p.keyEnv}`);
    else checks.push(...(await planeChecks(company, new Plane(p, key))));
  } else add('warn', 'Plane not configured: agents only get Obsidian inbox notes and manual wakes');

  const folder = fabrikFolder(company);
  if (folder) {
    try {
      accessSync(existsSync(folder) ? folder : dirname(folder), constants.W_OK);
      add('ok', `Obsidian folder ${folder} writable`);
    } catch {
      add('fail', `Obsidian folder ${folder} not writable`);
    }
  } else add('warn', 'Obsidian not configured: no journals or status cards');

  const skill = [join(company.root, '.claude', 'skills', 'fabrik', 'SKILL.md'), join(homedir(), '.agents', 'skills', 'fabrik', 'SKILL.md'), join(homedir(), '.claude', 'skills', 'fabrik', 'SKILL.md')].find(existsSync);
  add(skill ? 'ok' : 'warn', skill ? `fabrik skill installed (${skill})` : 'fabrik skill not installed: run fabrik apply, or npx skills add danglenoir/fabrik -g -a claude-code codex grok');

  const pid = daemonPid(company);
  add(pid ? 'ok' : 'warn', pid ? `daemon running (pid ${pid})` : 'daemon not running: fabrik service install (or fabrik daemon)');
  return checks;
}

/** Plane checks for doctor: key, workspace membership, projects, the states fabrik uses, key scope. */
export async function planeChecks(company: Company, plane: Plane): Promise<Check[]> {
  const p = company.config.plane!;
  const checks: Check[] = [];
  const add = (level: Check['level'], text: string) => checks.push({ level, text });
  let user: string;
  try {
    const me = await plane.me();
    user = me.display_name ?? me.email ?? me.id;
    add('ok', `Plane ${p.url} as ${user}`);
  } catch (err) {
    const status = (err as PlaneHttpError).status;
    add('fail', status === 401 ? `Plane rejected the key in ${p.keyEnv}; create a new one and run fabrik secret set ${p.keyEnv}` : `Plane: ${(err as Error).message}`);
    return checks;
  }
  let projects;
  try {
    projects = await plane.projects();
  } catch (err) {
    if ((err as PlaneHttpError).status === 403 || (err as PlaneHttpError).status === 404) {
      add('fail', `Plane user ${user} is not a member of workspace "${p.workspace}", or the slug is wrong. The slug is the first path segment of your Plane URLs: ${p.url}/<workspace-slug>/projects/...`);
    } else add('fail', `Plane: ${(err as Error).message}`);
    return checks;
  }
  for (const ident of p.projects) {
    const proj = projects.find((x) => x.identifier === ident);
    if (!proj) { add('fail', `Plane project ${ident} not found in workspace ${p.workspace} (visible: ${projects.map((x) => x.identifier).join(', ') || 'none'})`); continue; }
    const states = await plane.states(proj.id);
    const missing = [['todo', 'unstarted'], ['done', 'completed']].filter(([, g]) => !states.some((s) => s.group === g)).map(([w]) => w);
    if (missing.length) { add('fail', `Plane project ${ident} has no ${missing.join('/')} state`); continue; }
    add('ok', `Plane project ${ident}: ${states.map((s) => s.name).join(', ')}`);
    // The heartbeat moves tickets to In Review and Blocked; without them they silently land in In Progress.
    for (const [word, re, name] of [['in_review', /review/i, 'In Review'], ['blocked', /block/i, 'Blocked']] as const) {
      if (!states.some((s) => re.test(s.name))) add('warn', `Plane project ${ident} has no "${name}" state: add one in the Started group (\`task state ${word}\` falls back to ${states.find((s) => s.group === 'started')?.name ?? 'In Progress'})`);
    }
    const def = states.find((s) => s.id === proj.defaultState);
    if (def?.group === 'backlog') add('ok', `new ${ident} tickets start in ${def.name}: agents are woken when a ticket moves to Todo or later`);
  }
  const extra = projects.filter((x) => !p.projects.includes(x.identifier)).map((x) => x.identifier);
  if (extra.length) add('warn', `the Plane key also reaches ${extra.join(', ')}; keys carry their user's full rights, so consider a dedicated fabrik user limited to ${p.projects.join(', ')}`);
  return checks;
}

export function readSkill(name: string): string {
  return readFileSync(join(FABRIK_ROOT, 'skills', name, 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '');
}
