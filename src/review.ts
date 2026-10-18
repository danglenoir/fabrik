import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import { GEAR_NAMES, GEARS, loadCompany } from './company.ts';
import type { Company, Gear, Harness } from './company.ts';
import { setAgentFields, setGear, setTopLevel } from './edit.ts';
import { ADAPTERS } from './harness.ts';
import { Herdr } from './herdr.ts';
import { FabrikError, readJson, sleep, writeFileAtomic, writeJson } from './util.ts';

/**
 * `fabrik review`: a picker for the team's models, efforts and gear, and for switching agents on
 * or off. It edits an onboarding proposal before `fabrik init`, or a running company. Inside herdr
 * it opens as a popup, so it looks the same whichever harness ran the onboarding.
 */

export const EFFORTS: Record<Harness, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  grok: ['low', 'medium', 'high', 'xhigh'],
  hermes: [],
};

export interface ReviewAgent {
  slug: string;
  title: string;
  harness: Harness;
  model: string;
  effort: string | null;
  enabled: boolean;
  /** Why the agent cannot be switched off, if it cannot. */
  locked: string | null;
  models: string[];
}

export interface Review {
  name: string;
  agents: ReviewAgent[];
  gear: Gear;
  row: number; // 0..agents.length-1: an agent; agents.length: the gear
  notice: string;
}

export type ReviewAction = 'up' | 'down' | 'left' | 'right' | 'effort' | 'toggle' | 'gear' | 'accept' | 'cancel';

const KEYS: Record<string, ReviewAction> = {
  '\u001b[A': 'up', k: 'up', '\u001b[B': 'down', j: 'down', '\u001b[D': 'left', h: 'left', '\u001b[C': 'right', l: 'right',
  e: 'effort', ' ': 'toggle', g: 'gear', '\r': 'accept', '\n': 'accept', '\u001b': 'cancel', q: 'cancel', '\u0003': 'cancel',
};

export function keyAction(data: string): ReviewAction | null {
  return KEYS[data] ?? null;
}

function cycle<T>(list: T[], current: T, step: number): T {
  if (list.length === 0) return current;
  const i = list.indexOf(current);
  return list[(((i < 0 ? 0 : i + step) % list.length) + list.length) % list.length]!;
}

/** Apply one key to the review. Returns 'accept' or 'cancel' when the picker should close. */
export function update(r: Review, action: ReviewAction): 'accept' | 'cancel' | null {
  const agent = r.row < r.agents.length ? r.agents[r.row] : undefined;
  r.notice = '';
  switch (action) {
    case 'up': r.row = Math.max(0, r.row - 1); break;
    case 'down': r.row = Math.min(r.agents.length, r.row + 1); break;
    case 'left':
    case 'right':
      if (agent) agent.model = cycle(agent.models, agent.model, action === 'right' ? 1 : -1);
      else r.gear = cycle([...GEAR_NAMES], r.gear, 1);
      break;
    case 'effort':
      if (agent) agent.effort = agent.effort === null ? (EFFORTS[agent.harness][0] ?? null) : cycle(EFFORTS[agent.harness], agent.effort, 1);
      break;
    case 'toggle':
      if (!agent) r.gear = cycle([...GEAR_NAMES], r.gear, 1);
      else if (agent.locked && agent.enabled) r.notice = `${agent.slug} stays on: ${agent.locked}`;
      else agent.enabled = !agent.enabled;
      break;
    case 'gear': r.gear = cycle([...GEAR_NAMES], r.gear, 1); break;
    case 'accept': return 'accept';
    case 'cancel': return 'cancel';
  }
  return null;
}

// Colours: the terminal default plus the ANSI palette, which herdr maps to its theme.
const sgr = (code: string) => (text: string) => `\u001b[${code}m${text}\u001b[0m`;
const bold = sgr('1');
const dim = sgr('2');
const green = sgr('32');
const yellow = sgr('33');
const plainLength = (s: string) => s.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').length;
const pad = (s: string, width: number) => s + ' '.repeat(Math.max(0, width - plainLength(s)));

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** The picker as lines for a terminal `width` x `height`. */
export function renderReview(r: Review, width: number, height: number): string[] {
  const slugW = Math.max(4, ...r.agents.map((a) => a.slug.length));
  const titleW = Math.min(14, Math.max(5, ...r.agents.map((a) => a.title.length)));
  const harnessW = Math.max(6, ...r.agents.map((a) => a.harness.length));
  const modelW = Math.max(8, ...r.agents.map((a) => a.models.reduce((m, x) => Math.max(m, x.length), a.model.length))) + 4;
  const rows = r.agents.map((a, i) => {
    const cursor = i === r.row ? bold('❯') : ' ';
    const mark = a.enabled ? green('✔') : dim('✗');
    const text = `${a.slug.padEnd(slugW)}  ${a.title.slice(0, titleW).padEnd(titleW)}  ${a.harness.padEnd(harnessW)}  ${`‹ ${a.model} ›`.padEnd(modelW)}  effort ‹ ${a.effort ?? '-'} ›`;
    return `${cursor} ${mark} ${a.enabled ? (i === r.row ? bold(text) : text) : dim(text)}`;
  });
  // Keep the cursor visible when the team is taller than the popup.
  const gearLines = GEAR_NAMES.length * 2 + 1;
  const room = Math.max(3, height - gearLines - 6);
  const first = Math.min(Math.max(0, r.row - room + 1), Math.max(0, rows.length - room));
  const shown = rows.slice(first, first + room);
  if (first > 0) shown[0] = dim(`  ↑ ${first} more`);
  if (first + room < rows.length) shown[shown.length - 1] = dim(`  ↓ ${rows.length - first - room + 1} more`);

  const gearCursor = r.row === r.agents.length ? bold('❯') : ' ';
  const descW = Math.max(20, width - 19);
  const gear: string[] = [];
  for (const [i, g] of GEAR_NAMES.entries()) {
    const [head, ...rest] = wrap(GEARS[g].summary, descW);
    const label = `${r.gear === g ? '●' : '○'} ${g.padEnd(7)}`;
    gear.push(`${i === 0 ? `${gearCursor} Gear  ` : '        '}${r.gear === g ? bold(label) : dim(label)}  ${head ?? ''}`);
    for (const more of rest) gear.push(`${' '.repeat(19)}${more}`);
  }
  const footer = dim('↑↓ agent · ←→ model · e effort · space on/off · g gear · enter accept · esc cancel');
  return [
    ` ${bold(r.name)} ${dim('· review your team')}`,
    '',
    ...shown,
    '',
    ...gear,
    '',
    r.notice ? ` ${yellow(r.notice)}` : '',
    ` ${footer}`,
  ].map((l) => (plainLength(l) > width ? l : pad(l, width)));
}

/** One line per agent, for whoever ran `fabrik review`. */
export function summary(r: Review): string {
  const agents = r.agents.map((a) => a.enabled ? `${a.slug} ${a.harness}/${a.model}${a.effort ? ` (${a.effort})` : ''}` : `${a.slug} off`);
  return `gear ${r.gear}; ${agents.join(', ')}`;
}

/** Models a harness offers; tests pass their own. */
export type ModelLister = (harness: Harness) => Promise<string[] | null>;
const harnessModels: ModelLister = (harness) => ADAPTERS[harness].listModels().catch(() => null);

async function modelsFor(list: ModelLister, harness: Harness, current: string): Promise<string[]> {
  const listed = (await list(harness)) ?? [];
  return listed.includes(current) ? listed : [current, ...listed];
}

// ---------- sources: an onboarding proposal or a company ----------

export interface ReviewTarget {
  load(): Promise<Review>;
  save(r: Review): void;
  resultPath: string;
}

export function proposalTarget(path: string, list: ModelLister = harnessModels): ReviewTarget {
  const file = resolve(path);
  return {
    resultPath: `${file}.review.json`,
    async load() {
      const raw = parseDocument(readFileSync(file, 'utf8')).toJS() as Record<string, any>;
      const agents: Record<string, any>[] = Array.isArray(raw.agents) ? raw.agents : [];
      if (agents.length === 0) throw new FabrikError('invalid_proposal', `${file} has no agents`);
      const router = raw.router?.unassigned;
      return {
        name: raw.company?.name ?? raw.company?.slug ?? 'New company',
        gear: GEAR_NAMES.includes(raw.gear) ? raw.gear : 'steady',
        row: 0,
        notice: '',
        agents: await Promise.all(agents.map(async (a) => ({
          slug: String(a.slug), title: String(a.title ?? ''), harness: a.harness as Harness, model: String(a.model), effort: a.effort ? String(a.effort) : null,
          enabled: a.enabled !== false,
          locked: a.reports_to === null || a.reports_to === undefined ? 'the top of the org' : a.slug === router ? 'it triages unassigned tickets' : null,
          models: await modelsFor(list, a.harness as Harness, String(a.model)),
        }))),
      };
    },
    save(r) {
      const doc = parseDocument(readFileSync(file, 'utf8'));
      setTopLevel(doc, 'gear', r.gear);
      r.agents.forEach((a, i) => {
        // An edited `{ … }` entry would be re-printed as a sprawling flow map; write it as a block.
        const node = doc.getIn(['agents', i], true);
        if (isMap(node)) node.flow = false;
        doc.setIn(['agents', i, 'model'], a.model);
        doc.setIn(['agents', i, 'effort'], a.effort);
        if (a.enabled) doc.deleteIn(['agents', i, 'enabled']);
        else doc.setIn(['agents', i, 'enabled'], false);
      });
      writeFileAtomic(file, doc.toString());
    },
  };
}

export function companyTarget(company: Company, list: ModelLister = harnessModels): ReviewTarget {
  return {
    resultPath: resolve(company.stateDir, 'review.json'),
    async load() {
      const router = company.config.router.unassigned;
      return {
        name: company.config.company.name,
        gear: company.config.gear,
        row: 0,
        notice: '',
        agents: await Promise.all(company.agents.filter((a) => ADAPTERS[a.harness].supported).map(async (a) => ({
          slug: a.slug, title: a.title, harness: a.harness, model: a.model, effort: a.effort, enabled: a.enabled,
          locked: a.reportsTo === null ? 'the top of the org' : a.slug === router ? 'it triages unassigned tickets' : null,
          models: await modelsFor(list, a.harness, a.model),
        }))),
      };
    },
    save(r) {
      for (const a of r.agents) {
        const before = company.agents.find((x) => x.slug === a.slug)!;
        if (before.model !== a.model || before.effort !== a.effort || before.enabled !== a.enabled) {
          setAgentFields(company, a.slug, { model: a.model, effort: a.effort, enabled: a.enabled });
        }
      }
      if (r.gear !== company.config.gear) setGear(company, r.gear);
    },
  };
}

/** A company directory (with fabrik.yaml) or an onboarding proposal file. */
export function reviewTarget(path: string): ReviewTarget {
  const full = resolve(path);
  return existsSync(join(full, 'fabrik.yaml')) ? companyTarget(loadCompany(full)) : proposalTarget(full);
}

// ---------- running the picker ----------

/** Run the picker in this terminal until enter or esc. Saves on enter. */
export async function runPicker(target: ReviewTarget): Promise<{ outcome: 'accept' | 'cancel'; summary: string }> {
  const review = await target.load();
  const draw = () => {
    const lines = renderReview(review, process.stdout.columns || 86, process.stdout.rows || 24);
    process.stdout.write(`\u001b[H${lines.map((l) => `${l}\u001b[K`).join('\r\n')}\u001b[J`);
  };
  process.stdin.setRawMode(true);
  process.stdout.write('\u001b[?25l');
  try {
    draw();
    const outcome = await new Promise<'accept' | 'cancel'>((done) => {
      process.stdin.on('data', (d) => {
        const action = keyAction(String(d));
        if (!action) return;
        const result = update(review, action);
        if (result) done(result);
        else draw();
      });
    });
    if (outcome === 'accept') target.save(review);
    return { outcome, summary: summary(review) };
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\u001b[0m\u001b[?25h\u001b[H\u001b[J');
  }
}

/** The herdr popup's side: run the picker and leave the outcome where `fabrik review` waits for it. */
export async function reviewPane(target: ReviewTarget): Promise<void> {
  try {
    writeJson(target.resultPath, { ...(await runPicker(target)), at: Date.now() });
  } catch (err) {
    writeJson(target.resultPath, { outcome: 'error', summary: (err as Error).message, at: Date.now() });
    throw err;
  }
}

/**
 * The caller's side: open the picker as a herdr popup and wait for the human. Agents run commands
 * with time limits, so give up after `waitMs` and let the caller run `fabrik review --wait` again.
 */
export async function reviewInHerdr(target: ReviewTarget, targetArg: string, opts: { reopen: boolean; waitMs: number }): Promise<{ outcome: string; summary: string } | null> {
  if (opts.reopen) {
    if (existsSync(target.resultPath)) unlinkSync(target.resultPath);
    const herdr = new Herdr(process.env.HERDR_SESSION || 'default');
    await herdr.run(['plugin', 'pane', 'open', '--plugin', 'fabrik', '--entrypoint', 'review', '--env', `FABRIK_REVIEW_TARGET=${targetArg}`]);
  }
  for (const end = Date.now() + opts.waitMs; Date.now() < end;) {
    const result = readJson<{ outcome: string; summary: string } | null>(target.resultPath, null);
    if (result) return result;
    await sleep(1000);
  }
  return null;
}
