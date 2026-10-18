import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export class FabrikError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Parse "90s", "10m", "6h", "1d", "off" (null) or a bare number of seconds into milliseconds. */
export function parseDuration(value: string | number | boolean | null | undefined): number | null {
  if (value === null || value === undefined || value === false || value === 'off') return null;
  if (value === true) throw new FabrikError('invalid_duration', 'duration must be a value like "6h", not true');
  if (typeof value === 'number') return value * 1000;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(value.trim());
  if (!m) throw new FabrikError('invalid_duration', `invalid duration: ${value}`);
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1000;
  return n * factor;
}

/** The inverse of parseDuration for display: 300000 -> "5m", 5400000 -> "1h30m", null -> "off". */
export function formatDuration(ms: number | null): string {
  if (ms === null) return 'off';
  let rest = Math.round(ms / 1000) * 1000;
  let out = '';
  for (const [unit, size] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]] as const) {
    const n = Math.floor(rest / size);
    if (n) { out += `${n}${unit}`; rest -= n * size; }
  }
  return out || '0s';
}

/** Write a file atomically: temp file in the same directory, then rename. */
export function writeFileAtomic(path: string, data: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
  renameSync(tmp, path);
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n');
}

export function appendJsonl(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(value) + '\n');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date, YYYY-MM-DD. Journals and the daily run cap follow the human's day, not UTC. */
export function today(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Local "YYYY-MM-DD HH:MM" for notes a human reads. Machine logs (runs.jsonl, events.jsonl) stay in UTC. */
export function localStamp(now = new Date()): string {
  return `${today(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function shortId(prefix: string): string {
  const t = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 12);
  return `${prefix}${t}${randomBytes(2).toString('hex')}`;
}

export function log(...parts: unknown[]): void {
  process.stderr.write(`[fabrik ${new Date().toISOString()}] ${parts.map(String).join(' ')}\n`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fabrik's own config dir. FABRIK_CONFIG_DIR isolates tests without touching XDG_*, which harnesses also read. */
export function fabrikConfigDir(): string {
  return process.env.FABRIK_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'fabrik');
}

/**
 * Run `fn` while holding an exclusive lock file (O_EXCL create). A lock older than `staleMs`
 * belongs to a crashed holder and is broken. Used for state.json and the shared Plane rate limit.
 */
export async function withFileLock<T>(lock: string, fn: () => T | Promise<T>, opts: { timeoutMs?: number; staleMs?: number } = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const staleMs = opts.staleMs ?? 120_000;
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) unlinkSync(lock);
      } catch { /* lock vanished between calls */ }
      if (Date.now() > deadline) throw new FabrikError('locked', `${lock} is locked; is another fabrik command stuck?`);
      await sleep(25 + Math.random() * 50);
    }
  }
  try {
    return await fn();
  } finally {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}
