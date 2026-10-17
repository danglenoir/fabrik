import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { diffIssue, enqueue, mentions, wakeText } from '../src/rules.ts';
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
