import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, isScalar, parseDocument } from 'yaml';
import type { Document } from 'yaml';
import { GEAR_NAMES } from './company.ts';
import type { Company, Gear } from './company.ts';
import { FabrikError, writeFileAtomic } from './util.ts';

/**
 * In-place edits of the files a human also edits (fabrik.yaml, agents/<slug>/AGENTS.md, proposals).
 * They go through the YAML document model so comments and key order survive.
 */

/** Set a top-level key; a new key goes right after `after` instead of at the end of the file. */
export function setTopLevel(doc: Document, key: string, value: unknown, after = 'company'): void {
  if (doc.has(key) || !isMap(doc.contents)) { doc.set(key, value); return; }
  const items = doc.contents.items;
  const at = items.findIndex((p) => isScalar(p.key) && p.key.value === after);
  doc.set(key, value);
  if (at >= 0) items.splice(at + 1, 0, items.pop()!);
}

export function setGear(company: Company, gear: string): Gear {
  if (!GEAR_NAMES.includes(gear as Gear)) throw new FabrikError('usage', `gear must be ${GEAR_NAMES.join(' or ')}`);
  const path = join(company.root, 'fabrik.yaml');
  const doc = parseDocument(readFileSync(path, 'utf8'));
  setTopLevel(doc, 'gear', gear);
  writeFileAtomic(path, doc.toString());
  return gear as Gear;
}

export interface AgentFields { model?: string; effort?: string | null; enabled?: boolean }

/** Change frontmatter fields of agents/<slug>/AGENTS.md, keeping the instructions below it. */
export function setAgentFields(company: Company, slug: string, fields: AgentFields): void {
  const path = join(company.root, 'agents', slug, 'AGENTS.md');
  const text = readFileSync(path, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new FabrikError('invalid_agent', `${path} has no frontmatter`);
  const doc = parseDocument(m[1]!);
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) doc.set(key, value);
  writeFileAtomic(path, `---\n${doc.toString().trimEnd()}\n---\n${m[2]}`);
}
