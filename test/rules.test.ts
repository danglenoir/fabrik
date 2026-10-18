import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { diffIssue, enqueue, limitAgentChatter, mentions, wakeText } from '../src/rules.ts';
import type { PlaneComment, PlaneIssue } from '../src/plane.ts';
import type { IssueSnap, WakeItem } from '../src/state.ts';
import { makeCompany } from './helpers.ts';

const company = makeCompany({ plane: { url: 'http://x', workspace: 'acme', projects: ['ACME'] } });

function issue(over: Partial<PlaneIssue> = {}): PlaneIssue {
  return { id: 'i1', key: 'ACME-1', projectId: 'p', name: 'x', labels: [], stateId: 's', stateName: 'Todo', stateGroup: 'unstarted', parent: null, updatedAt: 't2', descriptionHtml: '', ...over };
}
function snap(over: Partial<IssueSnap> = {}): IssueSnap {
  return { key: 'ACME-1', labels: [], stateGroup: 'unstarted', parent: null, updatedAt: 't1', ...over };
}
function comment(text: string): PlaneComment {
  return { id: text, issueId: 'i1', html: '', text, actor: 'u', createdAt: 't' };
}
const ctx = { snaps: {}, askHuman: {} };

test('label agent:<slug> assigns', () => {
  const ev = diffIssue(company, snap(), issue({ labels: ['agent:cody'] }), [], ctx);
  assert.deepEqual(ev, [{ agent: 'cody', key: 'ACME-1', reason: 'assigned' }]);
  assert.deepEqual(diffIssue(company, snap({ labels: ['agent:cody'] }), issue({ labels: ['agent:cody'] }), [], ctx), []);
  assert.deepEqual(diffIssue(company, snap(), issue({ labels: ['agent:cody'], stateGroup: 'backlog' }), [], ctx), [], 'backlog is not ready');
});

test('comments wake the assignee but not its own comments', () => {
  const prev = snap({ labels: ['agent:cody'] });
  const now = issue({ labels: ['agent:cody'] });
  assert.equal(diffIssue(company, prev, now, [comment('please also add tests')], ctx)[0]?.reason, 'comment from a human');
  assert.deepEqual(diffIssue(company, prev, now, [comment('fabrik:cody done with step 1')], ctx), []);
  assert.equal(diffIssue(company, prev, now, [comment('fabrik:ada looks good')], ctx)[0]?.reason, 'comment from ada');
});

test('the agent holding the claim follows comments on an unlabelled ticket', () => {
  const ev = diffIssue(company, snap(), issue(), [comment('please hurry')], { snaps: {}, askHuman: {}, claims: { 'ACME-1': 'ada' } });
  assert.deepEqual(ev, [{ agent: 'ada', key: 'ACME-1', reason: 'comment from a human' }]);
});

test('@mentions wake other agents', () => {
  assert.deepEqual(mentions(company, 'hey @ada and @cody, not @nobody or mail@ada'), ['ada', 'cody']);
  const ev = diffIssue(company, snap({ labels: ['agent:cody'] }), issue({ labels: ['agent:cody'] }), [comment('fabrik:cody @ada can you decide?')], ctx);
  assert.deepEqual(ev, [{ agent: 'ada', key: 'ACME-1', reason: 'mentioned by cody' }]);
});

test('new unassigned tickets go to the router; human tickets do not', () => {
  assert.deepEqual(diffIssue(company, undefined, issue(), [], ctx), [{ agent: 'ada', key: 'ACME-1', reason: 'new unassigned ticket to triage' }]);
  assert.deepEqual(diffIssue(company, undefined, issue({ labels: ['human'] }), [], ctx), []);
});

test('reopen, children done and human answers', () => {
  const reopened = diffIssue(company, snap({ labels: ['agent:cody'], stateGroup: 'completed' }), issue({ labels: ['agent:cody'] }), [], ctx);
  assert.ok(reopened.some((e) => e.reason === 'reopened'));

  const snaps = {
    parent: snap({ key: 'ACME-9', labels: ['agent:ada'], stateGroup: 'started' }),
    sib: snap({ key: 'ACME-11', parent: 'parent', stateGroup: 'completed' }),
  };
  const ev = diffIssue(company, snap({ parent: 'parent', stateGroup: 'started' }), issue({ id: 'i10', key: 'ACME-10', parent: 'parent', stateGroup: 'completed' }), [], { snaps, askHuman: {} });
  assert.deepEqual(ev, [{ agent: 'ada', key: 'ACME-9', reason: 'all sub-tasks done' }]);

  const asked = diffIssue(company, snap({ labels: ['human'] }), issue({ labels: ['human'] }), [comment('yes, go ahead')], { snaps: {}, askHuman: { i1: 'cody' } });
  assert.deepEqual(asked, [{ agent: 'cody', key: 'ACME-1', reason: 'human answered' }]);
});

test('leaving the backlog makes a ticket ready', () => {
  const labelled = diffIssue(company, snap({ labels: ['agent:cody'], stateGroup: 'backlog' }), issue({ labels: ['agent:cody'] }), [], ctx);
  assert.deepEqual(labelled, [{ agent: 'cody', key: 'ACME-1', reason: 'assigned' }]);
  const unlabelled = diffIssue(company, snap({ stateGroup: 'backlog' }), issue(), [], ctx);
  assert.deepEqual(unlabelled, [{ agent: 'ada', key: 'ACME-1', reason: 'new unassigned ticket to triage' }]);
  assert.deepEqual(diffIssue(company, snap({ labels: ['agent:cody'] }), issue({ labels: ['agent:cody'], stateGroup: 'started' }), [], ctx), [], 'todo -> in progress is not a new assignment');
});

test('sub-tasks done: only for an open parent, and questions to the human do not count', () => {
  const child = () => issue({ id: 'i10', key: 'ACME-10', parent: 'parent', stateGroup: 'completed' });
  const prevChild = snap({ parent: 'parent', stateGroup: 'started' });
  const closedParent = { parent: snap({ key: 'ACME-9', labels: ['agent:ada'], stateGroup: 'completed' }) };
  assert.deepEqual(diffIssue(company, prevChild, child(), [], { snaps: closedParent, askHuman: {} }), [], 'parent already closed');

  const withQuestion = {
    parent: snap({ key: 'ACME-9', labels: ['agent:ada'], stateGroup: 'started' }),
    question: snap({ key: 'ACME-12', labels: ['human'], parent: 'parent', stateGroup: 'unstarted' }),
  };
  assert.deepEqual(diffIssue(company, prevChild, child(), [], { snaps: withQuestion, askHuman: {} }), [{ agent: 'ada', key: 'ACME-9', reason: 'all sub-tasks done' }]);

  const questionClosed = diffIssue(company, snap({ labels: ['human'], parent: 'parent' }), issue({ id: 'question', key: 'ACME-12', labels: ['human'], parent: 'parent', stateGroup: 'completed' }), [], { snaps: withQuestion, askHuman: { question: 'ada' } });
  assert.deepEqual(questionClosed, [{ agent: 'ada', key: 'ACME-12', reason: 'human resolved your question' }]);
});

test('loop guard limits agents waking each other on one ticket, never humans', () => {
  const history: Record<string, number[]> = {};
  const agentEv = { agent: 'ada', key: 'ACME-3', reason: 'mentioned by wren' };
  const humanEv = { agent: 'ada', key: 'ACME-3', reason: 'comment from a human' };
  let kept = 0;
  for (let i = 0; i < 6; i++) kept += limitAgentChatter([agentEv], history, 1_000 + i).kept.length;
  assert.equal(kept, 4);
  assert.equal(limitAgentChatter([humanEv], history, 2_000).kept.length, 1);
  assert.equal(limitAgentChatter([agentEv], history, 1_000 + 3_600_001).kept.length, 1, 'the window slides');
});

test('a mention wake says the ticket belongs to someone else', () => {
  assert.match(wakeText('R1', [{ key: 'ACME-3', reasons: ['mentioned by wren'], firstAt: 0, lastAt: 0 }]), /belongs to someone else/);
  assert.doesNotMatch(wakeText('R1', [{ key: 'ACME-3', reasons: ['assigned'], firstAt: 0, lastAt: 0 }]), /belongs to someone else/);
});

test('queue coalesces by key and wake text lists reasons', () => {
  const q: WakeItem[] = [];
  enqueue(q, { agent: 'cody', key: 'ACME-1', reason: 'assigned' }, 1);
  enqueue(q, { agent: 'cody', key: 'ACME-1', reason: 'comment from a human' }, 2);
  enqueue(q, { agent: 'cody', key: 'ACME-1', reason: 'assigned' }, 3);
  enqueue(q, { agent: 'cody', key: 'ACME-2', reason: 'assigned' }, 4);
  assert.equal(q.length, 2);
  assert.deepEqual(q[0]!.reasons, ['assigned', 'comment from a human']);
  assert.match(wakeText('R1', q), /^\[fabrik wake run=R1\] ACME-1: assigned, comment from a human; ACME-2: assigned\./);
});
