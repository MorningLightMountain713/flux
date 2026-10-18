// A mutation breaks one rule in a copy of the tree, to prove a suite fails
// without it. A suite's mutations are data, in mutations/<suite>.json:
//
//   [{
//     "name": "keep-list-never-sent",
//     "breaks": "FluxOS sends no keep list with an update",
//     "edits": [{ "file": "ZelBack/src/...js", "from": "<exact text>", "to": "<replacement>" }],
//     "red": ["<it() title>", ...]
//   }]
//
// `file` is relative to the repo root, the vendored FluxDrive source
// (test-infra/fluxdrive/src/...) and the runner's own framework included.
// `from` occurs exactly once in its file. `red` names, by it() title, every test
// the mutation fails; a run passes only when exactly those fail.
// mutate.js runs a set.

const NAME = /^[a-z0-9][a-z0-9-]*$/;
// A docker tag is at most 128 characters; `mut-<suite>-<run>-` takes the rest.
const NAME_MAX = 100;
const TAP_LINE = /^(ok|not ok) \d+ (.*)$/;

/**
 * Every reason a suite's mutation list cannot be run, empty when it can.
 * @param {unknown} list - the parsed mutations/<suite>.json
 * @returns {string[]}
 */
export function mutationListProblems(list) {
  if (!Array.isArray(list) || list.length === 0) return ['the file holds no list of mutations'];
  const problems = [];
  const seen = new Set();
  list.forEach((m, i) => {
    const at = `mutation ${i}${typeof m?.name === 'string' ? ` (${m.name})` : ''}`;
    if (typeof m?.name !== 'string' || !NAME.test(m.name) || m.name.length > NAME_MAX) {
      problems.push(`${at}: name is lower-case letters, digits and dashes, at most ${NAME_MAX}`);
    } else if (seen.has(m.name)) {
      problems.push(`${at}: the name is used twice`);
    } else {
      seen.add(m.name);
    }
    if (typeof m?.breaks !== 'string' || !m.breaks.trim()) problems.push(`${at}: breaks says which rule it breaks`);
    if (!Array.isArray(m?.edits) || m.edits.length === 0) {
      problems.push(`${at}: edits holds at least one edit`);
    } else {
      m.edits.forEach((e, j) => {
        if (typeof e?.file !== 'string' || !e.file || e.file.startsWith('/') || e.file.split('/').includes('..')) {
          problems.push(`${at} edit ${j}: file is a path inside the repo`);
        }
        if (typeof e?.from !== 'string' || !e.from) problems.push(`${at} edit ${j}: from is the exact text replaced`);
        if (typeof e?.to !== 'string' || e.to === e?.from) problems.push(`${at} edit ${j}: to is the text that replaces it`);
      });
    }
    if (!Array.isArray(m?.red) || m.red.length === 0 || !m.red.every((t) => typeof t === 'string' && t)) {
      problems.push(`${at}: red names every test the mutation fails`);
    }
  });
  return problems;
}

/**
 * The tag a mutation's images are built under, one per run, so two runs of the
 * same suite on one box never share, or remove, each other's images.
 * @param {string} suite - the suite's number
 * @param {number} run - the run's process id
 * @param {string} name - the mutation's name
 */
export function mutationTag(suite, run, name) {
  return `mut-${suite}-${run}-${name}`;
}

/**
 * The file's text with one edit made.
 * @param {string} text
 * @param {{file:string, from:string, to:string}} edit
 * @returns {string}
 * @throws when `from` does not occur exactly once
 */
export function applyEdit(text, edit) {
  const count = text.split(edit.from).length - 1;
  if (count !== 1) throw new Error(`${edit.file}: the text to replace occurs ${count} times, not once: ${JSON.stringify(edit.from)}`);
  return text.replace(edit.from, () => edit.to);
}

/**
 * The tests a mocha TAP report records, in order.
 * @param {string} tap
 * @returns {Array<{ok:boolean, title:string}>}
 */
export function tapResults(tap) {
  const results = [];
  for (const line of tap.split('\n')) {
    const m = TAP_LINE.exec(line);
    if (m) results.push({ ok: m[1] === 'ok', title: m[2] });
  }
  return results;
}

/**
 * Whether a run failed exactly the declared tests. A TAP title is the describe
 * title, a space, then the it() title, so a declared title matches the one
 * result it ends.
 * @param {Array<{ok:boolean, title:string}>} results
 * @param {string[]} red - the it() titles expected to fail; empty for a control
 * @returns {{ok:boolean, failed:string[], reasons:string[]}}
 */
export function judgeRun(results, red) {
  const failed = results.filter((r) => !r.ok).map((r) => r.title);
  if (results.length === 0) return { ok: false, failed, reasons: ['the run recorded no tests'] };
  const reasons = [];
  const declared = new Set();
  for (const title of red) {
    const matches = results.filter((r) => r.title.endsWith(` ${title}`));
    if (matches.length !== 1) {
      reasons.push(`"${title}" names ${matches.length} tests of the run`);
      continue;
    }
    declared.add(matches[0].title);
    if (matches[0].ok) reasons.push(`passed, declared red: ${matches[0].title}`);
  }
  for (const title of failed) {
    if (!declared.has(title)) reasons.push(`failed, not declared red: ${title}`);
  }
  return { ok: reasons.length === 0, failed, reasons };
}
