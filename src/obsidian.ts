import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Company } from './company.ts';
import { parseFrontmatter } from './company.ts';
import { today, writeFileAtomic } from './util.ts';

/**
 * Plain-file Obsidian integration. fabrik only writes below <vault>/<folder>/ and gives every
 * note a single writer: status cards belong to the daemon, journals to their agent, the inbox
 * to the human. Works with the Obsidian app closed.
 */
export function fabrikFolder(company: Company): string | null {
  const o = company.config.obsidian;
  return o ? join(o.vault, o.folder) : null;
}

function append(path: string, header: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileAtomic(path, header);
  appendFileSync(path, line.endsWith('\n') ? line : line + '\n');
}

export function appendJournal(company: Company, slug: string, text: string, now = new Date()): string | null {
  const root = fabrikFolder(company);
  if (!root) return null;
  const date = today(now);
  const path = join(root, 'journal', slug, `${date}.md`);
  const time = now.toISOString().slice(11, 16);
  append(path, `---\nagent: ${slug}\ndate: ${date}\ntags: [fabrik/journal]\n---\n\n# ${slug} — ${date}\n\n`, `- ${time} ${text.replace(/\n+/g, ' ')}`);
  return path;
}

export function appendAttention(company: Company, text: string, now = new Date()): string | null {
  const root = fabrikFolder(company);
  if (!root) return null;
  const path = join(root, 'attention.md');
  append(path, '---\ntags: [fabrik/attention]\n---\n\n# Needs your attention\n\nNewest at the bottom. Delete lines once handled.\n\n',
    `- [ ] ${now.toISOString().slice(0, 16).replace('T', ' ')} ${text.replace(/\n+/g, ' ')}`);
  return path;
}

export interface StatusCard {
  slug: string;
  name: string;
  title: string;
  harness: string;
  model: string;
  status: string;
  queue: string[];
  runsToday: number;
  lastRun: string;
  paused: boolean;
}

export function writeStatusCard(company: Company, card: StatusCard): void {
  const root = fabrikFolder(company);
  if (!root) return;
  const body = `---
agent: ${card.slug}
name: ${JSON.stringify(card.name)}
title: ${JSON.stringify(card.title)}
harness: ${card.harness}
model: ${JSON.stringify(card.model)}
status: ${card.status}
paused: ${card.paused}
runs_today: ${card.runsToday}
last_run: ${JSON.stringify(card.lastRun)}
tags: [fabrik/agent]
---

# ${card.name} — ${card.title}

<!-- written by the fabrik daemon; edits are overwritten -->

- Status: **${card.status}**${card.paused ? ' (paused)' : ''}
- Queue: ${card.queue.length ? card.queue.join(', ') : 'empty'}
- Runs today: ${card.runsToday}
- Last run: ${card.lastRun || 'never'}
- Journal: [[journal/${card.slug}/${today()}]]
`;
  const path = join(root, 'agents', `${card.slug}.md`);
  if (existsSync(path) && readFileSync(path, 'utf8') === body) return; // avoid churning LiveSync
  writeFileAtomic(path, body);
}

export interface InboxNote {
  path: string; // relative to the fabrik folder
  mtimeMs: number;
  to: string[];
  title: string;
  body: string;
}

/** Notes in <folder>/inbox/ with frontmatter `to: <slug>` (or a list) and no `status: done`. */
export function scanInbox(company: Company): InboxNote[] {
  const root = fabrikFolder(company);
  if (!root) return [];
  const dir = join(root, 'inbox');
  if (!existsSync(dir)) return [];
  const notes: InboxNote[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const path = join(dir, f);
    const st = statSync(path);
    if (!st.isFile()) continue;
    let parsed;
    try {
      parsed = parseFrontmatter(readFileSync(path, 'utf8'));
    } catch {
      continue; // half-written or merge-conflicted frontmatter: skip until it parses
    }
    const { data, body } = parsed;
    if (String(data.status ?? '').toLowerCase() === 'done') continue;
    const to = Array.isArray(data.to) ? data.to.map(String) : data.to ? [String(data.to)] : [];
    if (to.length === 0) continue;
    notes.push({ path: relative(root, path), mtimeMs: st.mtimeMs, to, title: f.replace(/\.md$/, ''), body });
  }
  return notes;
}
