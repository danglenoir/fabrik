import { execFile } from 'node:child_process';
import { FabrikError } from './util.ts';

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface HerdrAgent {
  name?: string | null;
  agent: string;
  agent_status: AgentStatus;
  completion_seq: number;
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  cwd?: string;
  agent_session?: { value?: string } | null;
}

export interface HerdrTab { tab_id: string; workspace_id: string; label: string }
export interface HerdrWorkspace { workspace_id: string; label: string }

export class HerdrError extends FabrikError {}

export interface MetadataOptions {
  displayAgent?: string;
  title?: string;
  tokens?: Record<string, string>;
  stateLabels?: Record<string, string>;
}

/** Thin wrapper over the herdr CLI. Every call returns the parsed `.result` object. */
export class Herdr {
  readonly session: string;
  readonly bin: string;

  constructor(session = 'default', bin = process.env.HERDR_BIN_PATH || 'herdr') {
    this.session = session;
    this.bin = bin;
  }

  run(args: string[], timeoutMs = 60_000): Promise<any> {
    const argv = this.session === 'default' ? args : ['--session', this.session, ...args];
    const env = { ...process.env };
    if (this.session !== 'default') {
      // An explicit session must win over the socket inherited from the pane we may be running in.
      for (const k of Object.keys(env)) if (k.startsWith('HERDR_') && k !== 'HERDR_BIN_PATH') delete env[k];
    }
    return new Promise((resolve, reject) => {
      execFile(this.bin, argv, { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) {
          const out = stdout.trim();
          if (!out) return resolve({});
          try {
            const parsed = JSON.parse(out);
            return resolve(parsed.result ?? parsed);
          } catch {
            return resolve({ text: out });
          }
        }
        const text = (stderr || stdout || '').trim();
        try {
          const e = JSON.parse(text).error;
          return reject(new HerdrError(e.code ?? 'herdr_error', e.message ?? text));
        } catch {
          const code = (err as NodeJS.ErrnoException & { killed?: boolean }).killed ? 'timeout' : 'herdr_failed';
          return reject(new HerdrError(code, `herdr ${args.slice(0, 2).join(' ')}: ${text || err.message}`));
        }
      });
    });
  }

  async workspaces(): Promise<HerdrWorkspace[]> {
    return (await this.run(['workspace', 'list'])).workspaces ?? [];
  }

  async createWorkspace(label: string, cwd: string): Promise<{ workspace: HerdrWorkspace; tab: HerdrTab; root_pane: { pane_id: string } }> {
    return this.run(['workspace', 'create', '--label', label, '--cwd', cwd, '--no-focus']);
  }

  async tabs(workspaceId: string): Promise<HerdrTab[]> {
    return (await this.run(['tab', 'list', '--workspace', workspaceId])).tabs ?? [];
  }

  async createTab(workspaceId: string, label: string, cwd: string): Promise<{ tab: HerdrTab; root_pane: { pane_id: string } }> {
    return this.run(['tab', 'create', '--workspace', workspaceId, '--label', label, '--cwd', cwd, '--no-focus']);
  }

  async renameTab(tabId: string, label: string): Promise<void> {
    await this.run(['tab', 'rename', tabId, label]);
  }

  async panes(workspaceId: string): Promise<Array<{ pane_id: string; tab_id: string }>> {
    return (await this.run(['pane', 'list', '--workspace', workspaceId])).panes ?? [];
  }

  async agents(): Promise<HerdrAgent[]> {
    return (await this.run(['agent', 'list'])).agents ?? [];
  }

  async agent(name: string): Promise<HerdrAgent> {
    const r = await this.run(['agent', 'get', name]);
    return r.agent ?? r;
  }

  async renameAgent(target: string, name: string): Promise<void> {
    await this.run(['agent', 'rename', target, name]);
  }

  async startAgent(name: string, kind: string, paneId: string, args: string[], timeoutMs: number): Promise<HerdrAgent> {
    const t = Math.min(Math.max(timeoutMs, 3000), 300_000);
    const r = await this.run(['agent', 'start', name, '--kind', kind, '--pane', paneId, '--timeout', String(t), '--', ...args], t + 15_000);
    return r.agent ?? r;
  }

  /** Submit a prompt. Without `waitMs` it returns once the text and Enter are written. */
  async prompt(name: string, text: string, waitMs?: number): Promise<any> {
    const args = ['agent', 'prompt', name, text];
    if (waitMs !== undefined) args.push('--wait', '--timeout', String(waitMs));
    return this.run(args, (waitMs ?? 30_000) + 15_000);
  }

  async waitFor(name: string, status: AgentStatus, timeoutMs: number): Promise<any> {
    return this.run(['agent', 'wait', name, '--until', status, '--timeout', String(timeoutMs)], timeoutMs + 15_000);
  }

  async read(name: string, source = 'visible', lines = 60): Promise<string> {
    const r = await this.run(['agent', 'read', name, '--source', source, '--lines', String(lines)]);
    return String(r.text ?? r.content ?? r.output ?? '');
  }

  async sendKeys(name: string, keys: string[]): Promise<void> {
    await this.run(['agent', 'send-keys', name, ...keys]);
  }

  async reportMetadata(paneId: string, m: MetadataOptions): Promise<void> {
    const args = ['pane', 'report-metadata', paneId, '--source', 'fabrik'];
    if (m.displayAgent) args.push('--display-agent', m.displayAgent.slice(0, 80));
    if (m.title) args.push('--title', m.title.slice(0, 80));
    for (const [k, v] of Object.entries(m.tokens ?? {})) args.push('--token', `${k}=${v.slice(0, 80)}`);
    for (const [k, v] of Object.entries(m.stateLabels ?? {})) args.push('--state-label', `${k}=${v.slice(0, 80)}`);
    await this.run(args);
  }

  async notify(title: string, body?: string): Promise<void> {
    const args = ['notification', 'show', title];
    if (body) args.push('--body', body);
    await this.run(args).catch(() => undefined); // toasts are best-effort: off by default, need an attached client
  }
}
