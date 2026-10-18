import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Company } from './company.ts';
import { FabrikError } from './util.ts';

/** Claims are files in .fabrik/claims/<KEY>.json, created with O_EXCL so only one agent can hold a ticket. */
function claimsDir(company: Company): string {
  return join(company.stateDir, 'claims');
}

function claimPath(company: Company, key: string): string {
  return join(claimsDir(company), `${key.toUpperCase()}.json`);
}

export function claimHolder(company: Company, key: string): string | null {
  const path = claimPath(company, key);
  if (!existsSync(path)) return null;
  try {
    return String(JSON.parse(readFileSync(path, 'utf8')).agent);
  } catch {
    return null;
  }
}

/** Every held claim, as ticket key -> agent slug. */
export function allClaims(company: Company): Record<string, string> {
  const dir = claimsDir(company);
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const key = f.slice(0, -5);
    const holder = claimHolder(company, key);
    if (holder) out[key] = holder;
  }
  return out;
}

/** Atomic claim: O_EXCL create of claims/<KEY>.json. Returns false if another agent holds it. */
export function takeClaim(company: Company, key: string, slug: string): boolean {
  const path = claimPath(company, key);
  mkdirSync(claimsDir(company), { recursive: true });
  try {
    const fd = openSync(path, 'wx');
    writeSync(fd, JSON.stringify({ agent: slug, at: new Date().toISOString() }));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return claimHolder(company, key) === slug;
  }
}

export function dropClaim(company: Company, key: string, slug: string | null, force = false): boolean {
  const holder = claimHolder(company, key);
  if (holder === null) return false;
  if (holder !== slug && !force) throw new FabrikError('not_your_claim', `${key} is claimed by ${holder}`);
  try { unlinkSync(claimPath(company, key)); } catch { /* raced with another release */ }
  return true;
}
