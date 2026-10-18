import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

/** In-memory stand-in for the Plane CE /api/v1 endpoints fabrik uses. */
export interface FakeIssue {
  id: string; sequence_id: number; name: string; labels: string[]; state: string; parent: string | null;
  updated_at: string; description_html: string; project: string;
}
export interface FakeComment { id: string; issue: string; comment_html: string; comment_stripped: string; actor: string; created_at: string }

export class FakePlane {
  key = 'test-key';
  workspace = 'acme';
  project = { id: randomUUID(), identifier: 'ACME', name: 'Acme' };
  states = [
    { id: randomUUID(), name: 'Backlog', group: 'backlog' },
    { id: randomUUID(), name: 'Todo', group: 'unstarted' },
    { id: randomUUID(), name: 'In Progress', group: 'started' },
    { id: randomUUID(), name: 'In Review', group: 'started' },
    { id: randomUUID(), name: 'Done', group: 'completed' },
    { id: randomUUID(), name: 'Cancelled', group: 'cancelled' },
  ];
  labels: Array<{ id: string; name: string }> = [];
  issues: FakeIssue[] = [];
  comments: FakeComment[] = [];
  requests: string[] = [];
  rateLimitNext = 0;
  /** Other projects the key can see (they have no work items). */
  extraProjects: Array<{ id: string; identifier: string; name: string }> = [];
  private clock = Date.parse('2026-10-17T08:00:00Z');
  url = '';
  private server = createServer((req, res) => this.handle(req, res));

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }

  tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  state(name: string): string {
    return this.states.find((s) => s.name === name)!.id;
  }

  label(name: string): string {
    let l = this.labels.find((x) => x.name === name);
    if (!l) { l = { id: randomUUID(), name }; this.labels.push(l); }
    return l.id;
  }

  addIssue(name: string, opts: { labels?: string[]; state?: string; parent?: string | null } = {}): FakeIssue {
    const issue: FakeIssue = {
      id: randomUUID(), sequence_id: this.issues.length + 1, name, labels: (opts.labels ?? []).map((l) => this.label(l)),
      state: this.state(opts.state ?? 'Todo'), parent: opts.parent ?? null, updated_at: this.tick(), description_html: `<p>${name}</p>`, project: this.project.id,
    };
    this.issues.push(issue);
    return issue;
  }

  setLabels(issue: FakeIssue, names: string[]): void {
    issue.labels = names.map((n) => this.label(n));
    issue.updated_at = this.tick();
  }

  setState(issue: FakeIssue, name: string): void {
    issue.state = this.state(name);
    issue.updated_at = this.tick();
  }

  addComment(issue: FakeIssue, text: string, actor = 'human-user'): FakeComment {
    const c = { id: randomUUID(), issue: issue.id, comment_html: `<p>${text}</p>`, comment_stripped: text, actor, created_at: this.tick() };
    this.comments.push(c);
    issue.updated_at = this.tick();
    return c;
  }

  private send(res: import('node:http').ServerResponse, status: number, body?: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'X-RateLimit-Remaining': '59', 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 1) });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }

  private handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', this.url);
      this.requests.push(`${req.method} ${url.pathname}${url.search}`);
      if (req.headers['x-api-key'] !== this.key) return this.send(res, 401, { error: 'bad key' });
      if (this.rateLimitNext > 0) { this.rateLimitNext--; return this.send(res, 429, { error: 'slow down' }); }
      const body = raw ? JSON.parse(raw) : {};
      const p = url.pathname.replace(/^\/api\/v1/, '');
      const ws = `/workspaces/${this.workspace}`;
      const proj = `${ws}/projects/${this.project.id}`;
      let m: RegExpExecArray | null;

      if (p === '/users/me/') return this.send(res, 200, { id: 'fabrik-user', display_name: 'fabrik' });
      if (p.startsWith('/workspaces/') && !p.startsWith(`${ws}/`)) return this.send(res, 403, { detail: 'You do not have permission to perform this action.' });
      if (p === `${ws}/projects/`) return this.send(res, 200, { results: [this.project, ...this.extraProjects] });
      if (p === `${proj}/states/`) return this.send(res, 200, { results: this.states });
      if (p === `${proj}/labels/` && req.method === 'GET') return this.send(res, 200, { results: this.labels });
      if (p === `${proj}/labels/` && req.method === 'POST') return this.send(res, 201, { id: this.label(body.name), name: body.name });
      if (p === `${proj}/work-items/` && req.method === 'GET') {
        const per = Number(url.searchParams.get('per_page') ?? 50);
        const start = Number(url.searchParams.get('cursor') ?? 0);
        const sorted = [...this.issues].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        const page = sorted.slice(start, start + per);
        const more = start + per < sorted.length;
        return this.send(res, 200, { results: page, next_cursor: more ? String(start + per) : null, next_page_results: more });
      }
      if (p === `${proj}/work-items/` && req.method === 'POST') {
        const issue: FakeIssue = {
          id: randomUUID(), sequence_id: this.issues.length + 1, name: body.name, labels: body.labels ?? [], state: body.state ?? this.state('Todo'),
          parent: body.parent ?? null, updated_at: this.tick(), description_html: body.description_html ?? '', project: this.project.id,
        };
        this.issues.push(issue);
        return this.send(res, 201, issue);
      }
      if ((m = new RegExp(`^${ws}/work-items/ACME-(\\d+)/$`).exec(p))) {
        const issue = this.issues.find((i) => i.sequence_id === Number(m![1]));
        return issue ? this.send(res, 200, issue) : this.send(res, 404, { error: 'not found' });
      }
      if ((m = new RegExp(`^${proj}/work-items/([^/]+)/$`).exec(p)) && req.method === 'PATCH') {
        const issue = this.issues.find((i) => i.id === m![1]);
        if (!issue) return this.send(res, 404, {});
        if (body.state) issue.state = body.state;
        if (body.labels) issue.labels = body.labels;
        if (body.name) issue.name = body.name;
        issue.updated_at = this.tick();
        return this.send(res, 200, issue);
      }
      if ((m = new RegExp(`^${proj}/work-items/([^/]+)/comments/$`).exec(p))) {
        const issue = this.issues.find((i) => i.id === m![1]);
        if (!issue) return this.send(res, 404, {});
        if (req.method === 'GET') return this.send(res, 200, { results: this.comments.filter((c) => c.issue === issue.id) });
        const text = String(body.comment_html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const c = { id: randomUUID(), issue: issue.id, comment_html: body.comment_html, comment_stripped: text, actor: 'fabrik-user', created_at: this.tick() };
        this.comments.push(c);
        issue.updated_at = this.tick();
        return this.send(res, 201, c);
      }
      return this.send(res, 404, { error: `no route ${req.method} ${p}` });
    });
  }
}
