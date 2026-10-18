// A mutation run is the proof a suite can fail, so a reading here that passes a
// run which failed the wrong tests, or none, would prove nothing. These pin the
// list's checks, the edit, the TAP reading and the verdict. `npm run test:unit`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEdit, judgeRun, mutationListProblems, mutationTag, tapResults,
} from '../framework/mutation.js';

const mutation = (over = {}) => ({
  name: 'keep-list-never-sent',
  breaks: 'FluxOS sends no keep list',
  edits: [{ file: 'ZelBack/src/a.js', from: 'return true;', to: 'return false;' }],
  red: ['retires the file the update drops'],
  ...over,
});

describe('mutationListProblems', () => {
  it('accepts a well-formed list', () => {
    assert.deepEqual(mutationListProblems([mutation(), mutation({ name: 'other' })]), []);
  });
  it('refuses an empty list or one that is not a list', () => {
    assert.equal(mutationListProblems([]).length, 1);
    assert.equal(mutationListProblems({ name: 'x' }).length, 1);
  });
  it('refuses a name a docker tag cannot carry', () => {
    assert.match(mutationListProblems([mutation({ name: 'Keep_List' })])[0], /name is lower-case/);
    assert.match(mutationListProblems([mutation({ name: 'a'.repeat(101) })])[0], /at most 100/);
  });
  it('refuses a name used twice', () => {
    assert.match(mutationListProblems([mutation(), mutation()])[0], /used twice/);
  });
  it('refuses a mutation that says nothing about what it breaks', () => {
    assert.match(mutationListProblems([mutation({ breaks: ' ' })])[0], /breaks says/);
  });
  it('refuses a mutation with no edits', () => {
    assert.match(mutationListProblems([mutation({ edits: [] })])[0], /at least one edit/);
  });
  it('refuses an edit outside the repo', () => {
    assert.match(mutationListProblems([mutation({ edits: [{ file: '/etc/passwd', from: 'a', to: 'b' }] })])[0], /inside the repo/);
    assert.match(mutationListProblems([mutation({ edits: [{ file: 'x/../../y', from: 'a', to: 'b' }] })])[0], /inside the repo/);
  });
  it('refuses an edit that changes nothing', () => {
    assert.match(mutationListProblems([mutation({ edits: [{ file: 'a.js', from: 'a', to: 'a' }] })])[0], /to is the text/);
    assert.match(mutationListProblems([mutation({ edits: [{ file: 'a.js', from: '', to: 'a' }] })])[0], /from is the exact text/);
  });
  it('refuses a mutation that declares no red test', () => {
    assert.match(mutationListProblems([mutation({ red: [] })])[0], /red names/);
    assert.match(mutationListProblems([mutation({ red: [''] })])[0], /red names/);
  });
});

describe('mutationTag', () => {
  it('names the suite and the mutation', () => {
    assert.equal(mutationTag('2723', 'keep-list-never-sent'), 'mut-2723-keep-list-never-sent');
  });
});

describe('applyEdit', () => {
  const edit = { file: 'a.js', from: 'if (!holds) {', to: 'if (false) {' };
  it('replaces the one occurrence', () => {
    assert.equal(applyEdit('x\nif (!holds) {\ny', edit), 'x\nif (false) {\ny');
  });
  it('refuses text that is absent', () => {
    assert.throws(() => applyEdit('if (holds) {', edit), /occurs 0 times/);
  });
  it('refuses text that occurs twice', () => {
    assert.throws(() => applyEdit('if (!holds) {\nif (!holds) {', edit), /occurs 2 times/);
  });
  it('writes the replacement literally', () => {
    assert.equal(applyEdit('a', { file: 'a.js', from: 'a', to: '$&$1' }), '$&$1');
  });
});

describe('tapResults', () => {
  it('reads every ok and not ok line, in order', () => {
    const tap = [
      '1..3',
      'ok 1 suite registers the app',
      'not ok 2 suite retires the file',
      '  Error: expected false to be true',
      '# tests 3',
      'ok 3 suite installs from FluxDrive alone # SKIP -',
    ].join('\n');
    assert.deepEqual(tapResults(tap), [
      { ok: true, title: 'suite registers the app' },
      { ok: false, title: 'suite retires the file' },
      { ok: true, title: 'suite installs from FluxDrive alone # SKIP -' },
    ]);
  });
  it('reads nothing from a report with no tests', () => {
    assert.deepEqual(tapResults('###ABORT images do not match the tree'), []);
  });
});

describe('judgeRun', () => {
  const results = [
    { ok: true, title: 'a file sold registers the app' },
    { ok: false, title: 'a file sold retires the file' },
    { ok: true, title: 'a file sold installs from FluxDrive alone' },
  ];
  it('meets a declaration naming exactly the failed tests', () => {
    assert.deepEqual(judgeRun(results, ['retires the file']), { ok: true, failed: ['a file sold retires the file'], reasons: [] });
  });
  it('fails a declared test that passed', () => {
    const v = judgeRun(results, ['retires the file', 'installs from FluxDrive alone']);
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, ['passed, declared red: a file sold installs from FluxDrive alone']);
  });
  it('fails a test that failed undeclared', () => {
    const v = judgeRun(results, ['registers the app']);
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, [
      'passed, declared red: a file sold registers the app',
      'failed, not declared red: a file sold retires the file',
    ]);
  });
  it('fails a hook failure in place of the declared test', () => {
    const hooked = [{ ok: false, title: 'a file sold "before all" hook for "retires the file"' }];
    const v = judgeRun(hooked, ['retires the file']);
    assert.equal(v.ok, false);
    assert.deepEqual(v.reasons, [
      '"retires the file" names 0 tests of the run',
      'failed, not declared red: a file sold "before all" hook for "retires the file"',
    ]);
  });
  it('fails a declared title that names two tests', () => {
    const twice = [{ ok: false, title: 'x retires the file' }, { ok: false, title: 'y retires the file' }];
    assert.match(judgeRun(twice, ['retires the file']).reasons[0], /names 2 tests/);
  });
  it('fails a run that recorded no tests', () => {
    assert.deepEqual(judgeRun([], []), { ok: false, failed: [], reasons: ['the run recorded no tests'] });
  });
  it('meets a control only when every test passed', () => {
    assert.equal(judgeRun(results.filter((r) => r.ok), []).ok, true);
    assert.equal(judgeRun(results, []).ok, false);
  });
});
