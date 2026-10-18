import type { CompanyConfig } from './company.ts';
import { FabrikError, sleep } from './util.ts';

export interface PlaneState { id: string; name: string; group: string }
export interface PlaneLabel { id: string; name: string }
export interface PlaneProject { id: string; identifier: string; name: string }

export interface PlaneIssue {
  id: string;
  key: string;
  projectId: string;
  name: string;
  labels: string[];
  stateId: string;
  stateName: string;
  stateGroup: string;
  parent: string | null;
  updatedAt: string;
  descriptionHtml: string;
}

export interface PlaneComment {
  id: string;
  issueId: string;
  html: string;
  text: string;
  actor: string | null;
  createdAt: string;
}

/** fabrik signs comments it posts for an agent so the daemon can tell them apart. */
export const COMMENT_SIGNATURE_RE = /^\s*fabrik:([a-z][a-z0-9_-]{0,31})\b/;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function textToHtml(text: string): string {
  return text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

export function stripHtml(html: string): string {
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
}

type PlaneConfig = NonNullable<CompanyConfig['plane']>;

/** Plane Community Edition /api/v1 client (X-Api-Key). Cloud-only features are not used. */
export class Plane {
  private cfg: PlaneConfig;
  private key: string;
  private fetchImpl: typeof fetch;
  private sent: number[] = [];
  private projectCache: PlaneProject[] | null = null;
  private stateCache = new Map<string, PlaneState[]>();
  private labelCache = new Map<string, PlaneLabel[]>();

  constructor(cfg: PlaneConfig, apiKey: string, fetchImpl: typeof fetch = fetch) {
    if (!apiKey) throw new FabrikError('no_plane_key', `Plane API key missing: run fabrik secret set ${cfg.keyEnv}`);
    this.cfg = cfg;
    this.key = apiKey;
    this.fetchImpl = fetchImpl;
  }

  private async throttle(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.sent = this.sent.filter((t) => now - t < 60_000);
      if (this.sent.length < this.cfg.maxRpm) break;
      await sleep(60_000 - (now - this.sent[0]!) + 50);
    }
    this.sent.push(Date.now());
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const res = await this.fetchImpl(`${this.cfg.url}/api/v1${path}`, {
        method,
        headers: { 'X-Api-Key': this.key, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429 && attempt < 3) {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const wait = Number.isFinite(reset) && reset > 0 ? Math.max(1000, reset * 1000 - Date.now()) : 15_000;
        await sleep(Math.min(wait, 65_000));
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new FabrikError('plane_http', `Plane ${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
  }

  private ws(): string {
    return `/workspaces/${encodeURIComponent(this.cfg.workspace)}`;
  }

  async me(): Promise<{ id: string; display_name?: string; email?: string }> {
    return this.request('GET', '/users/me/');
  }

  async projects(): Promise<PlaneProject[]> {
    if (!this.projectCache) {
      const r = await this.request<any>('GET', `${this.ws()}/projects/`);
      const list: any[] = Array.isArray(r) ? r : (r.results ?? []);
      this.projectCache = list.map((p) => ({ id: p.id, identifier: p.identifier, name: p.name }));
    }
    return this.projectCache;
  }

  async project(identifier: string): Promise<PlaneProject> {
    const p = (await this.projects()).find((x) => x.identifier === identifier);
    if (!p) throw new FabrikError('plane_project', `Plane project ${identifier} not found in workspace ${this.cfg.workspace}`);
    return p;
  }

  async states(projectId: string): Promise<PlaneState[]> {
    if (!this.stateCache.has(projectId)) {
      const r = await this.request<any>('GET', `${this.ws()}/projects/${projectId}/states/`);
      const list: any[] = Array.isArray(r) ? r : (r.results ?? []);
      this.stateCache.set(projectId, list.map((s) => ({ id: s.id, name: s.name, group: s.group })));
    }
    return this.stateCache.get(projectId)!;
  }

  async labels(projectId: string, refresh = false): Promise<PlaneLabel[]> {
    if (refresh || !this.labelCache.has(projectId)) {
      const r = await this.request<any>('GET', `${this.ws()}/projects/${projectId}/labels/`);
      const list: any[] = Array.isArray(r) ? r : (r.results ?? []);
      this.labelCache.set(projectId, list.map((l) => ({ id: l.id, name: l.name })));
    }
    return this.labelCache.get(projectId)!;
  }

  async ensureLabel(projectId: string, name: string): Promise<PlaneLabel> {
    const existing = (await this.labels(projectId)).find((l) => l.name === name);
    if (existing) return existing;
    const created = await this.request<any>('POST', `${this.ws()}/projects/${projectId}/labels/`, { name });
    await this.labels(projectId, true);
    return { id: created.id, name: created.name };
  }

  private async toIssue(project: PlaneProject, raw: any): Promise<PlaneIssue> {
    let labels = await this.labels(project.id);
    const ids: string[] = (raw.labels ?? raw.label_ids ?? []).map((l: any) => (typeof l === 'string' ? l : l.id));
    if (ids.some((id) => !labels.find((l) => l.id === id))) labels = await this.labels(project.id, true);
    const states = await this.states(project.id);
    const stateId = typeof raw.state === 'string' ? raw.state : raw.state?.id ?? raw.state_id;
    const state = states.find((s) => s.id === stateId);
    return {
      id: raw.id,
      key: `${project.identifier}-${raw.sequence_id}`,
      projectId: project.id,
      name: raw.name,
      labels: ids.map((id) => labels.find((l) => l.id === id)?.name ?? id),
      stateId,
      stateName: state?.name ?? '',
      stateGroup: state?.group ?? '',
      parent: raw.parent ?? null,
      updatedAt: raw.updated_at,
      descriptionHtml: raw.description_html ?? '',
    };
  }

  /** Work items of a project, newest update first, stopping once older than `since`. */
  async issuesUpdatedSince(projectIdentifier: string, since: string | null, maxPages = 10): Promise<PlaneIssue[]> {
    const project = await this.project(projectIdentifier);
    const out: PlaneIssue[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({ order_by: '-updated_at', per_page: '50' });
      if (cursor) q.set('cursor', cursor);
      const r = await this.request<any>('GET', `${this.ws()}/projects/${project.id}/work-items/?${q}`);
      const list: any[] = Array.isArray(r) ? r : (r.results ?? []);
      let reachedOld = false;
      for (const raw of list) {
        if (since && raw.updated_at < since) { reachedOld = true; break; }
        out.push(await this.toIssue(project, raw));
      }
      if (reachedOld || Array.isArray(r) || !r.next_page_results || !r.next_cursor) break;
      cursor = r.next_cursor;
    }
    return out;
  }

  async issue(key: string): Promise<PlaneIssue> {
    const m = /^([A-Z0-9]+)-(\d+)$/i.exec(key);
    if (!m) throw new FabrikError('bad_key', `not a ticket key: ${key} (expected e.g. ACME-12)`);
    const project = await this.project(m[1]!.toUpperCase());
    const raw = await this.request<any>('GET', `${this.ws()}/work-items/${project.identifier}-${m[2]}/`);
    return this.toIssue(project, raw);
  }

  /** Direct sub-tasks of `issue`, from the 200 most recently updated tickets of its project. */
  async children(issue: PlaneIssue): Promise<PlaneIssue[]> {
    const project = issue.key.split('-')[0]!;
    return (await this.issuesUpdatedSince(project, null, 4)).filter((i) => i.parent === issue.id);
  }

  async comments(issue: PlaneIssue): Promise<PlaneComment[]> {
    const r = await this.request<any>('GET', `${this.ws()}/projects/${issue.projectId}/work-items/${issue.id}/comments/`);
    const list: any[] = Array.isArray(r) ? r : (r.results ?? []);
    return list.map((c) => ({
      id: c.id,
      issueId: issue.id,
      html: c.comment_html ?? '',
      text: c.comment_stripped ?? stripHtml(c.comment_html ?? ''),
      actor: c.actor ?? c.created_by ?? null,
      createdAt: c.created_at,
    })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async addComment(issue: PlaneIssue, html: string): Promise<PlaneComment> {
    const c = await this.request<any>('POST', `${this.ws()}/projects/${issue.projectId}/work-items/${issue.id}/comments/`, { comment_html: html });
    return { id: c.id, issueId: issue.id, html, text: stripHtml(html), actor: c.actor ?? null, createdAt: c.created_at };
  }

  async update(issue: PlaneIssue, patch: { state?: string; labels?: string[]; name?: string }): Promise<PlaneIssue> {
    const body: Record<string, unknown> = {};
    if (patch.state) body.state = patch.state;
    if (patch.name) body.name = patch.name;
    if (patch.labels) {
      const ids: string[] = [];
      for (const n of patch.labels) ids.push((await this.ensureLabel(issue.projectId, n)).id);
      body.labels = ids;
    }
    const raw = await this.request<any>('PATCH', `${this.ws()}/projects/${issue.projectId}/work-items/${issue.id}/`, body);
    const project = (await this.projects()).find((p) => p.id === issue.projectId)!;
    return this.toIssue(project, raw);
  }

  async create(projectIdentifier: string, input: { name: string; html?: string; labels?: string[]; parent?: string | null; state?: string }): Promise<PlaneIssue> {
    const project = await this.project(projectIdentifier);
    const labelIds: string[] = [];
    for (const n of input.labels ?? []) labelIds.push((await this.ensureLabel(project.id, n)).id);
    const raw = await this.request<any>('POST', `${this.ws()}/projects/${project.id}/work-items/`, {
      name: input.name,
      description_html: input.html ?? '',
      labels: labelIds,
      ...(input.parent ? { parent: input.parent } : {}),
      ...(input.state ? { state: input.state } : {}),
    });
    return this.toIssue(project, raw);
  }

  /** Map a fabrik state word to a project state id by Plane state group / name. */
  async stateFor(projectId: string, word: string): Promise<PlaneState> {
    const states = await this.states(projectId);
    const byName = (re: RegExp) => states.find((s) => re.test(s.name));
    const byGroup = (g: string) => states.find((s) => s.group === g);
    const pick = {
      backlog: () => byGroup('backlog'),
      todo: () => byName(/^todo$/i) ?? byGroup('unstarted'),
      in_progress: () => byName(/in.?progress/i) ?? byGroup('started'),
      in_review: () => byName(/review/i) ?? byGroup('started'),
      blocked: () => byName(/block/i) ?? byGroup('started'),
      done: () => byGroup('completed'),
      cancelled: () => byGroup('cancelled'),
    }[word];
    const s = pick?.();
    if (!s) throw new FabrikError('plane_state', `no Plane state for "${word}" (states: ${states.map((x) => x.name).join(', ')})`);
    return s;
  }
}
