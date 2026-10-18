import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { effectiveAutonomy } from './company.ts';
import type { AgentDef, Autonomy, Company, Harness } from './company.ts';
import { codexHome } from './isolation.ts';
import { FabrikError } from './util.ts';

export interface Dialog {
  name: string;
  pattern: RegExp;
  /** Keys that dismiss the dialog safely, or null when a human must decide. */
  keys: string[] | null;
}

export interface HarnessAdapter {
  harness: Harness;
  supported: boolean;
  /** Native launch args passed after `herdr agent start … --`. */
  launchArgs(agent: AgentDef, company: Company): string[];
  /** Keystroke command that starts a fresh conversation. */
  resetCommand: string;
  /** Keys that interrupt the current turn without leaving the harness. */
  interruptKeys: string[];
  /** Command that quits the harness back to the shell. */
  exitCommand: string;
  /** Known popups herdr may report as idle. Checked on screen before every wake. */
  dialogs: Dialog[];
  /** The folder-trust prompt shown on first start in a new directory. */
  trust: Dialog | null;
  /** Models the harness reports as available, or null when it cannot be asked. */
  listModels(): Promise<string[] | null>;
  /** Extra environment for the harness process, on top of agentEnv(). */
  env?(agent: AgentDef, company: Company): Record<string, string>;
}

function identityLine(agent: AgentDef, company: Company): string {
  return `You are ${agent.name}, ${agent.title} of ${company.config.company.name}, a fabrik agent (slug "${agent.slug}"). ` +
    `Your instructions are in AGENTS.md in your working directory. Use the fabrik CLI for tasks, notes and run reports; ` +
    `run the fabrik heartbeat procedure (skill "fabrik") whenever a message starts with "[fabrik wake".`;
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// low: ask before editing files or running commands (the fabrik CLI is always allowed).
// medium: no prompts for routine work; the harness's own safety classifier or sandbox decides.
// high: no prompts at all.
const CLAUDE_PERMISSION: Record<Autonomy, string> = { low: 'default', medium: 'auto', high: 'bypassPermissions' };
const GROK_PERMISSION: Record<Autonomy, string> = { low: 'default', medium: 'auto', high: 'bypassPermissions' };
const CODEX_PERMISSION: Record<Autonomy, string[]> = {
  low: ['-s', 'workspace-write', '-a', 'on-request'],
  medium: ['-s', 'workspace-write', '-a', 'never'],
  high: ['--dangerously-bypass-approvals-and-sandbox'],
};

export const CLAUDE_ALIASES = ['default', 'best', 'fable', 'opus', 'sonnet', 'haiku', 'opusplan', 'sonnet[1m]', 'opus[1m]'];

const claude: HarnessAdapter = {
  harness: 'claude',
  supported: true,
  launchArgs(agent, company) {
    // --add-dir: agents read ../../COMPANY.md, ORG.md and their notes without a permission prompt.
    const args = ['--model', agent.model, '--permission-mode', CLAUDE_PERMISSION[effectiveAutonomy(company, agent)], '-n', `${agent.name} (${agent.title})`, '--add-dir', company.root];
    const o = company.config.obsidian;
    if (o) args.push('--add-dir', join(o.vault, o.folder));
    if (agent.effort) args.push('--effort', agent.effort);
    // The fabrik CLI is the agent's own toolbelt: never ask before running it.
    args.push('--allowedTools', 'Bash(fabrik *)');
    // isolate: true skips the human's ~/.claude/settings.json (hooks, plugins, status line, user skills).
    if (company.config.isolate) args.push('--setting-sources', 'project,local');
    args.push('--append-system-prompt', identityLine(agent, company));
    return args;
  },
  resetCommand: '/clear',
  interruptKeys: ['esc'],
  exitCommand: '/exit',
  dialogs: [
    { name: 'auto-mode-tip', pattern: /Teach auto mode about your environment/i, keys: ['esc'] },
    { name: 'external-imports', pattern: /Allow external CLAUDE\.md file imports/i, keys: null },
  ],
  trust: { name: 'folder-trust', pattern: /trust (the files in )?this folder|Do you trust/i, keys: ['down', 'enter'] },
  async listModels() {
    return CLAUDE_ALIASES; // Claude also accepts full ids such as claude-sonnet-5-5
  },
};

const codex: HarnessAdapter = {
  harness: 'codex',
  supported: true,
  launchArgs(agent, company) {
    // No update prompt at startup: it blocks the pane until a human answers it.
    const args = ['-m', agent.model, ...CODEX_PERMISSION[effectiveAutonomy(company, agent)], '-c', 'check_for_update_on_startup=false'];
    if (effectiveAutonomy(company, agent) !== 'high') {
      // The workspace-write sandbox only covers the cwd and has no network. fabrik needs to
      // write claims/reports under .fabrik/, journals in the vault, and reach Plane.
      args.push('--add-dir', join(company.root, '.fabrik'));
      const o = company.config.obsidian;
      if (o) args.push('--add-dir', join(o.vault, o.folder));
      args.push('-c', 'sandbox_workspace_write.network_access=true');
    }
    if (agent.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(agent.effort)}`);
    args.push('-c', `developer_instructions=${JSON.stringify(identityLine(agent, company))}`);
    return args;
  },
  resetCommand: '/new',
  interruptKeys: ['esc'],
  exitCommand: '/exit',
  dialogs: [
    { name: 'update-prompt', pattern: /Update available[\s\S]*Skip until next version/i, keys: ['down', 'enter'] }, // "2. Skip"
    // `/new` in a git repository (every company is one) asks where to run; Enter keeps the current worktree.
    { name: 'worktree-picker', pattern: /Where should the new conversation run/i, keys: ['enter'] },
  ],
  trust: { name: 'folder-trust', pattern: /Do you trust the contents of this directory|trust this (folder|directory)/i, keys: null },
  env(_agent, company): Record<string, string> {
    // The human's ~/.codex minus its global AGENTS.md, which would compete with the company's instructions.
    return { CODEX_HOME: codexHome(company) };
  },
  async listModels() {
    const out = await exec('codex', ['debug', 'models']);
    try {
      const models: Array<{ slug: string; visibility?: string }> = JSON.parse(out).models ?? [];
      return models.filter((m) => m.visibility !== 'hide').map((m) => m.slug);
    } catch {
      return null;
    }
  },
};

const grok: HarnessAdapter = {
  harness: 'grok',
  supported: true,
  launchArgs(agent, company) {
    const args = ['-m', agent.model, '--permission-mode', GROK_PERMISSION[effectiveAutonomy(company, agent)], '--allow', 'Bash(fabrik *)'];
    if (agent.effort) args.push('--reasoning-effort', agent.effort);
    args.push('--rules', identityLine(agent, company));
    return args;
  },
  resetCommand: '/new',
  interruptKeys: ['esc'],
  exitCommand: '/exit',
  dialogs: [],
  trust: { name: 'folder-trust', pattern: /trust this folder|Do you trust/i, keys: null },
  async listModels() {
    const out = await exec('grok', ['models']);
    const found = [...out.matchAll(/^\s*[*-]\s+(grok-[\w.-]+)/gm)].map((m) => m[1] as string);
    return found.length ? found : null;
  },
};

const hermes: HarnessAdapter = {
  harness: 'hermes',
  supported: false, // v0.2: needs one Hermes profile per agent so the user's default persona stays untouched
  launchArgs() {
    throw new FabrikError('unsupported_harness', 'hermes agents are planned for fabrik v0.2 (one Hermes profile per agent)');
  },
  resetCommand: '/new now',
  interruptKeys: ['esc'],
  exitCommand: '/exit',
  dialogs: [],
  trust: null,
  async listModels() {
    return null;
  },
};

export const ADAPTERS: Record<Harness, HarnessAdapter> = { claude, codex, grok, hermes };

/**
 * Environment fabrik sets in an agent's pane before starting its harness, so the agent (and any
 * script it runs) knows where the company, its data and its notes live without asking.
 */
export function agentEnv(agent: AgentDef, company: Company): Record<string, string> {
  const env: Record<string, string> = {
    FABRIK_AGENT: agent.slug,
    FABRIK_COMPANY_DIR: company.root,
    FABRIK_DATA_DIR: company.stateDir,
  };
  const o = company.config.obsidian;
  if (o) {
    env.FABRIK_VAULT = o.vault;
    env.FABRIK_OBSIDIAN_DIR = join(o.vault, o.folder);
  }
  return { ...env, ...ADAPTERS[agent.harness].env?.(agent, company) };
}

/** Everything a running harness was started with. When it changes, the agent needs a restart. */
export function launchSignature(agent: AgentDef, company: Company): string {
  const adapter = ADAPTERS[agent.harness];
  if (!adapter.supported) return '';
  return JSON.stringify([agent.harness, adapter.launchArgs(agent, company), agentEnv(agent, company)]);
}

/** A POSIX `export` line for `env` (also understood by zsh and fish). The leading space keeps it out of shell history where configured. */
export function shellExport(env: Record<string, string>): string {
  const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  return ` export ${Object.entries(env).map(([k, v]) => `${k}=${quote(v)}`).join(' ')}`;
}

export function adapterFor(agent: AgentDef): HarnessAdapter {
  return ADAPTERS[agent.harness];
}
