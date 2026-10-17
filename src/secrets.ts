import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Company } from './company.ts';
import { fabrikConfigDir, writeFileAtomic } from './util.ts';

/** Secrets live outside the company repo in ~/.config/fabrik/<slug>.env (mode 0600). */
export function secretsPath(company: Company): string {
  return join(fabrikConfigDir(), `${company.config.company.slug}.env`);
}

export function readSecrets(company: Company): Record<string, string> {
  const path = secretsPath(company);
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function getSecret(company: Company, key: string): string {
  return process.env[key] || readSecrets(company)[key] || '';
}

export function setSecret(company: Company, key: string, value: string): string {
  const all = { ...readSecrets(company), [key]: value };
  const path = secretsPath(company);
  writeFileAtomic(path, Object.entries(all).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', 0o600);
  return path;
}
