import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { answerAsk, askRefusal, askText, awaitAnswer, createAsk, HUMAN, pruneAsks, replyFromScreen } from '../src/asks.ts';
import type { Company } from '../src/company.ts';
import { Daemon } from '../src/daemon.ts';
import { loadState, withState } from '../src/state.ts';
import { FakeHerdr, makeCompany } from './helpers.ts';

function office() {
  const company = makeCompany();
  const herdr = new FakeHerdr();
  herdr.addAgent('ada');
  herdr.addAgent('cody', 'idle', 'codex');
  const daemon = new Daemon(company);
  daemon.herdr = herdr as unknown as Daemon['herdr'];
  const agent = (slug: string) => company.agents.find((a) => a.slug === slug)!;
  return { company, herdr, daemon, ada: agent('ada'), cody: agent('cody') };
}

const asks = (company: Company) => Object.values(loadState(company).asks);
const promptsTo = (herdr: FakeHerdr, name: string) => herdr.prompts.filter((p) => p.name === name).map((p) => p.text);

test('a question reaches the colleague between its runs and the answer reaches the asker', async () => {
  const { company, herdr, daemon, ada, cody } = office();
  const ask = await createAsk(company, cody, 'ada', 'Which  database\ndo we use?', 'acme-4');
  assert.equal(ask.question, 'Which database do we use?', 'whitespace is folded so the prompt is one line');
  assert.equal(ask.ticket, 'ACME-4');
  await daemon.tick();
  const [typed] = promptsTo(herdr, 'ada');
  assert.ok(typed?.startsWith(`[fabrik question ${ask.id} from Cody (cody, Engineer), about ACME-4] Which database do we use?`));
  assert.match(typed!, new RegExp(`fabrik answer ${ask.id} "<answer>"`));
  assert.ok(!typed!.includes('\n'));
  assert.equal(asks(company)[0]!.status, 'delivered');

  assert.equal((await awaitAnswer(company, ask.id, 0)).status, 'delivered', 'a zero timeout returns at once');
  assert.match(await answerAsk(company, ada, ask.id, 'Postgres 17, see notes/db.md'), /answered q-/);
  const answered = await awaitAnswer(company, ask.id, 1000, 10);
  assert.equal(answered.answer, 'Postgres 17, see notes/db.md');
  assert.equal(answered.via, 'agent');
  assert.ok(asks(company)[0]!.collected);
});

test('a busy colleague gets the question once it is idle, and no wake while it answers', async () => {
  const { company, herdr, daemon } = office();
  herdr.find('ada')!.agent_status = 'working';
  const ask = await createAsk(company, null, 'ada', 'Status of the release?');
  assert.equal(ask.from, HUMAN);
  await daemon.tick();
  assert.equal(promptsTo(herdr, 'ada').length, 0);
  assert.equal(asks(company)[0]!.status, 'pending');

  herdr.find('ada')!.agent_status = 'idle';
  await withState(company, (s) => { s.agents.ada!.queue.push({ key: 'manual', reasons: ['manual wake'], firstAt: 0, lastAt: 0 }); });
  await daemon.tick();
  const typed = promptsTo(herdr, 'ada');
  assert.equal(typed.length, 1, 'the question goes first, the wake waits');
  assert.match(typed[0]!, /^\[fabrik question .* from Marton \(the human\)\]/);
  assert.equal(loadState(company).agents.ada!.queue.length, 1);
  assert.equal(daemon.gate(company.agents[0]!, loadState(company).agents.ada!, herdr.find('ada'), Date.now(), 0, asks(company)[0]), `answering ${ask.id}`);
});

test('an answer given in the chat is taken from the tab', async () => {
  const { company, herdr, daemon } = office();
  const ask = await createAsk(company, null, 'cody', 'Where is the API client?');
  await daemon.tick();
  herdr.find('cody')!.agent_status = 'working';
  await daemon.tick();
  herdr.find('cody')!.agent_status = 'idle';
  herdr.screens.cody = `› [fabrik question ${ask.id} from Marton (the human)] Where is the API client? — Answer …\n\n• It is in src/plane.ts,\n  class Plane.\n\n› `;
  await daemon.tick();
  const a = asks(company)[0]!;
  assert.equal(a.status, 'answered');
  assert.equal(a.via, 'screen');
  assert.equal(a.answer, '• It is in src/plane.ts,\n  class Plane.');
});

test('questions fail instead of hanging', async () => {
  const { company, herdr, daemon } = office();
  const silent = await createAsk(company, null, 'ada', 'Anyone there?');
  await daemon.tick();
  await withState(company, (s) => { s.asks[silent.id]!.deliveredAt = Date.now() - 10 * 60_000; });
  await daemon.tick();
  assert.match((await awaitAnswer(company, silent.id, 0)).error!, /ada did not react/);
  await answerAsk(company, null, silent.id, 'Sorry, here now.');
  assert.equal((await awaitAnswer(company, silent.id, 0)).answer, 'Sorry, here now.', 'a late answer is not lost');

  herdr.find('cody')!.agent_status = 'working';
  const stale = await createAsk(company, null, 'cody', 'Still busy?');
  await withState(company, (s) => { s.asks[stale.id]!.askedAt = Date.now() - 20 * 60_000; });
  await daemon.tick();
  assert.match((await awaitAnswer(company, stale.id, 0)).error!, /cody had no time for it in 15 minutes/);

  await withState(company, (s) => { s.asks[stale.id]!.askedAt = Date.now() - 25 * 3_600_000; pruneAsks(company, s, Date.now()); });
  await assert.rejects(awaitAnswer(company, stale.id, 0), /no question/);
});

test('an answer the asker stopped waiting for arrives as a wake, unless it was read meanwhile', async () => {
  const { company, herdr, daemon, ada, cody } = office();
  herdr.find('cody')!.agent_status = 'working';
  const ask = await createAsk(company, cody, 'ada', 'Ship today?');
  await daemon.tick();
  await answerAsk(company, ada, ask.id, 'Yes, after review.');
  await daemon.tick();
  assert.equal(loadState(company).agents.cody!.queue.length, 0, 'the asker may still be waiting');
  await withState(company, (s) => { s.asks[ask.id]!.closedAt = Date.now() - 60_000; });
  await daemon.tick();
  assert.deepEqual(loadState(company).agents.cody!.queue.map((q) => [q.key, q.reasons]), [[ask.id, ['answer from ada']]]);

  await awaitAnswer(company, ask.id, 0);
  await daemon.tick();
  assert.equal(loadState(company).agents.cody!.queue.length, 0);
});

test('asking has limits', async () => {
  const { company, ada, cody } = office();
  const state = loadState(company);
  const now = Date.now();
  assert.equal(askRefusal(company, state, 'cody', 'cody', now), 'you cannot ask yourself');
  assert.equal(askRefusal(company, state, 'cody', 'zed', now), 'no agent "zed"');
  const off = { ...company, agents: company.agents.map((a) => (a.slug === 'ada' ? { ...a, enabled: false } : a)) };
  assert.equal(askRefusal(off, state, 'cody', 'ada', now), 'ada is switched off');
  state.agents.ada!.paused = true;
  assert.match(askRefusal(company, state, 'cody', 'ada', now)!, /ada is paused/);
  state.agents.ada!.paused = false;

  const first = await createAsk(company, ada, 'cody', 'What blocks ACME-3?');
  await assert.rejects(createAsk(company, cody, 'ada', 'And you?'), new RegExp(`ada is waiting for your answer to ${first.id}`));
  await assert.rejects(createAsk(company, null, 'ada', 'Hi?'), /ada is waiting for an answer from cody itself/);
  await answerAsk(company, cody, first.id, 'Nothing.');
  await assert.rejects(answerAsk(company, cody, first.id, 'Again.'), /already answered/);
  await assert.rejects(answerAsk(company, ada, first.id, 'Me?'), /asked to cody, not to you/);

  for (let i = 0; i < 3; i++) {
    const q = await createAsk(company, ada, 'cody', `Question ${i}?`);
    await answerAsk(company, null, q.id, 'ok');
  }
  await assert.rejects(createAsk(company, ada, 'cody', 'A fifth?'), /4 questions in the last hour/);
  await createAsk(company, null, 'cody', 'The human is not limited');
  await assert.rejects(createAsk(company, cody, 'ada', 'x'.repeat(2001)), /limited to 2000 characters/);
});

test('the question text and the screen reader', () => {
  const { company } = office();
  const ask = { id: 'q-00ff', from: 'cody', ticket: null, question: 'Why?' } as Parameters<typeof askText>[1];
  assert.match(askText(company, ask), /^\[fabrik question q-00ff from Cody \(cody, Engineer\)\] Why\? — /);
  assert.match(askText(company, ask), /This is not a wake/);
  assert.equal(replyFromScreen('nothing here', 'q-00ff'), null);
  assert.equal(replyFromScreen('[fabrik question q-00ff from x] Why?\n', 'q-00ff'), null);
  assert.equal(replyFromScreen(`old [fabrik question q-00ff from x] Why?\nold\n[fabrik question q-00ff from x] Why?\nBecause.\n`, 'q-00ff'), 'Because.');
  assert.ok(replyFromScreen(`[fabrik question q-00ff from x] Why?\n${'y'.repeat(5000)}`, 'q-00ff')!.length <= 4001);
});
