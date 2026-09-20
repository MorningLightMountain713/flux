// The fleet a suite puts on the box at once, declared and derived.
//
// run-parallel.sh admits suites by nodes in flight, not by suite count: six
// 10-node fleets are what a 16-core box carries, and six 16-node ones are not.
// Every suite therefore declares its peak fleet on one line of its own:
//
//     // fleet: 16
//
// The number is the most nodes the suite has running at one time - the `nodes`
// plus `deferredNodes` of its largest env. Suites that boot several envs tear
// each down before the next, so the peak is the largest single env, not the sum.
//
// The declaration is what the launcher reads; the derivation here is what keeps
// it honest. check-fleet-declarations.js refuses a suite whose declaration is
// missing, or smaller than the fleet its own createTestEnv calls spell out. A
// suite that boots through a helper (the policy suites) derives nothing and is
// held to its declaration alone.

const DECLARATION = /^\/\/ fleet: (\S+)$/gm;
const CONST = /^\s*const\s+([A-Z_][A-Z0-9_]*)\s*=\s*(\d+)\s*;/gm;
const ARRAY = /^\s*const\s+([A-Z_][A-Z0-9_]*)\s*=\s*\[([^\]\n]*)\]\s*;/gm;

/** The declared peak fleet, or null when the line is absent. Throws on two lines
 *  or a value that is not a whole number: a declaration that cannot be read is
 *  not a smaller one. */
export function declaredFleet(source) {
  const found = [...source.matchAll(DECLARATION)];
  if (found.length === 0) return null;
  if (found.length > 1) throw new Error('more than one "// fleet:" line');
  const value = found[0][1];
  if (!/^\d+$/.test(value)) throw new Error(`"// fleet: ${value}" is not a whole number`);
  return Number(value);
}

/** Every `const NAME = <int>;` in the file, and the length of every one-line
 *  `const NAME = [ ... ];` as `NAME.length`: the vocabulary a nodes expression
 *  may use. */
function fileConstants(source) {
  const table = new Map();
  for (const m of source.matchAll(CONST)) table.set(m[1], Number(m[2]));
  for (const m of source.matchAll(ARRAY)) {
    const body = m[2].trim();
    table.set(`${m[1]}.length`, body === '' ? 0 : body.split(',').filter((e) => e.trim() !== '').length);
  }
  return table;
}

/** The text between the parentheses of each createTestEnv( call, balanced. */
function envCallArguments(source) {
  const calls = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf('createTestEnv(', from);
    if (at < 0) break;
    let depth = 0;
    let i = at + 'createTestEnv'.length;
    for (; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') { depth -= 1; if (depth === 0) break; }
    }
    calls.push(source.slice(at + 'createTestEnv('.length, i));
    from = i;
  }
  return calls;
}

/** A nodes expression is digits, file constants and literal-array lengths
 *  joined by `+`; anything else is unresolvable and reported, never guessed. */
function evaluate(expression, constants) {
  const terms = expression.trim().split('+').map((t) => t.trim());
  let total = 0;
  for (const term of terms) {
    if (/^\d+$/.test(term)) total += Number(term);
    else if (constants.has(term)) total += constants.get(term);
    else return null;
  }
  return total;
}

function field(args, name) {
  const m = args.match(new RegExp(`(?:^|[\\s,{])${name}:\\s*([^,}\\n]+)`));
  return m ? m[1].trim() : null;
}

/**
 * The peak fleet the suite's own createTestEnv calls spell out.
 * @returns {{ peak: number|null, envs: number, unresolved: string[] }}
 *   `peak` is null when the suite boots no env of its own or none resolves;
 *   `unresolved` lists every nodes expression the evaluator could not read.
 */
export function derivedFleet(source) {
  const constants = fileConstants(source);
  const calls = envCallArguments(source);
  let peak = null;
  const unresolved = [];
  for (const args of calls) {
    const nodesExpr = field(args, 'nodes') ?? '1';
    const deferredExpr = field(args, 'deferredNodes') ?? '0';
    const nodes = evaluate(nodesExpr, constants);
    const deferred = evaluate(deferredExpr, constants);
    if (nodes === null || deferred === null) {
      unresolved.push(nodes === null ? nodesExpr : deferredExpr);
      continue;
    }
    peak = Math.max(peak ?? 0, nodes + deferred);
  }
  return { peak, envs: calls.length, unresolved };
}

/**
 * The verdict on one suite file.
 * @returns {{ ok: boolean, declared: number|null, derived: number|null, reasons: string[] }}
 */
export function checkFleetDeclaration(source) {
  const reasons = [];
  let declared = null;
  try {
    declared = declaredFleet(source);
  } catch (e) {
    reasons.push(e.message);
  }
  if (declared === null && reasons.length === 0) reasons.push('no "// fleet: N" line');
  const { peak, unresolved } = derivedFleet(source);
  for (const expr of unresolved) reasons.push(`nodes expression not readable: ${expr}`);
  if (declared !== null && peak !== null && declared < peak) {
    reasons.push(`declares ${declared} but its own createTestEnv calls reach ${peak}`);
  }
  return { ok: reasons.length === 0, declared, derived: peak, reasons };
}
