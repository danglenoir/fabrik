import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { GEAR_NAMES } from './company.ts';
import type { Company, Gear } from './company.ts';
import { FabrikError, writeFileAtomic } from './util.ts';

/**
 * In-place edits of the files a human also edits (fabrik.yaml, agents/<slug>/AGENTS.md, proposals).
 * They go through the YAML document model so comments and key order survive.
 */

export function setGear(company: Company, gear: string): Gear {
  if (!GEAR_NAMES.includes(gear as Gear)) throw new FabrikError('usage', `gear must be ${GEAR_NAMES.join(' or ')}`);
  const path = join(company.root, 'fabrik.yaml');
  const doc = parseDocument(readFileSync(path, 'utf8'));
  doc.set('gear', gear);
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
