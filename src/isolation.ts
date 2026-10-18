import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Company } from './company.ts';
import { fabrikConfigDir } from './util.ts';

/**
 * Agents should follow the company's instructions, not the human's personal harness setup
 * (global AGENTS.md, Claude Code hooks, plugins and status line). Claude is started with
 * `--setting-sources project,local`; Codex gets its own CODEX_HOME. `inherit_user_config: true`
 * in fabrik.yaml turns this off.
 */

const SKILL_SOURCE = resolve(import.meta.dirname, '..', 'skills', 'fabrik', 'SKILL.md');

/** Copy the heartbeat skill into the company, where every harness finds it as a project skill. */
export function installCompanySkill(company: Company): void {
  const skill = readFileSync(SKILL_SOURCE, 'utf8');
  for (const dir of ['.claude', '.agents']) {
    const target = join(company.root, dir, 'skills', 'fabrik', 'SKILL.md');
    if (existsSync(target) && readFileSync(target, 'utf8') === skill) continue;
    mkdirSync(join(company.root, dir, 'skills', 'fabrik'), { recursive: true });
    copyFileSync(SKILL_SOURCE, target);
  }
}

function userCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

export function codexHome(company: Company): string {
  return join(fabrikConfigDir(), 'codex-home', company.config.company.slug);
}

/** Files Codex reads as global instructions; the company's CODEX_HOME leaves them out. */
const CODEX_GLOBAL_INSTRUCTIONS = new Set(['AGENTS.md', 'AGENTS.override.md']);

/**
 * Mirror the user's CODEX_HOME with symlinks (login, config, sessions, skills, herdr's hooks)
 * but without the global AGENTS.md. Safe to run repeatedly: it adds new entries, drops broken
 * links and leaves files Codex created inside the mirror alone.
 */
export function syncCodexHome(company: Company): string {
  const source = userCodexHome();
  const target = codexHome(company);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(target)) {
    const path = join(target, entry);
    if (lstatSync(path).isSymbolicLink() && (!existsSync(path) || CODEX_GLOBAL_INSTRUCTIONS.has(entry))) unlinkSync(path);
  }
  if (!existsSync(source)) return target;
  for (const entry of readdirSync(source)) {
    if (CODEX_GLOBAL_INSTRUCTIONS.has(entry)) continue;
    const path = join(target, entry);
    let present = true;
    try { lstatSync(path); } catch { present = false; }
    if (!present) symlinkSync(join(source, entry), path);
  }
  return target;
}

/** True when `path` in the company's CODEX_HOME still links to the user's file. */
export function codexHomeLinks(company: Company, entry: string): boolean {
  try {
    return readlinkSync(join(codexHome(company), entry)) === join(userCodexHome(), entry);
  } catch {
    return false;
  }
}
