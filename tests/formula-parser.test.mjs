import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, parseFormula, extractReferences, formatReference, parseReferenceBody, collectAstReferences, distinctReferences } from '../src/services/formula-parser.js';

test('tokenizes references, numbers, operators and functions', () => {
  const { tokens, errors } = tokenize('[VOLUME] * [PRICE] + SUM([A], 2.5%)');
  assert.equal(errors.length, 0);
  assert.deepEqual(tokens.map((t) => t.type), ['reference', 'op', 'reference', 'op', 'ident', 'lparen', 'reference', 'comma', 'number', 'rparen']);
  assert.equal(tokens[8].value, 0.025);
  assert.equal(tokens[8].percent, true);
});

test('parses a simple arithmetic formula into an AST', () => {
  const r = parseFormula('[VOLUME] * [PRICE]');
  assert.equal(r.ok, true);
  assert.equal(r.ast.type, 'binary');
  assert.equal(r.ast.op, '*');
  assert.deepEqual(r.references.map((x) => x.token), ['VOLUME', 'PRICE']);
});

test('respects operator precedence and parentheses', () => {
  const r = parseFormula('([REVENUE] - [OPEX]) / [REVENUE]');
  assert.equal(r.ok, true);
  assert.equal(r.ast.op, '/');
  assert.equal(r.ast.left.type, 'group');
  const r2 = parseFormula('[A] + [B] * [C]');
  assert.equal(r2.ast.op, '+');
  assert.equal(r2.ast.right.op, '*');
});

test('extracts explicit cross-scenario references', () => {
  const refs = extractReferences('[TT:REVENUE] * (1 + [GD:GROWTH_RATE]) + [VOLUME]');
  assert.deepEqual(refs.map((r) => [r.scenarioCode, r.token]), [['TT', 'REVENUE'], ['GD', 'GROWTH_RATE'], [null, 'VOLUME']]);
});

test('references may contain spaces, codes and dimension context', () => {
  const refs = extractReferences('[Room Nights Sold] / [M.000022 | Product=HRC; Entity=VN]');
  assert.equal(refs[0].token, 'Room Nights Sold');
  assert.equal(refs[1].token, 'M.000022');
  assert.deepEqual(refs[1].dimensionContext, [{ dimension: 'Product', member: 'HRC' }, { dimension: 'Entity', member: 'VN' }]);
});

test('reports syntax errors with positions but still extracts references', () => {
  const r = parseFormula('[VOLUME] * ');
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.deepEqual(r.references.map((x) => x.token), ['VOLUME']);
  const r2 = parseFormula('[A] +* [B]');
  assert.equal(r2.ok, false);
  assert.ok(r2.errors[0].position >= 4);
});

test('flags bare identifiers as an error with a bracket hint', () => {
  const r = parseFormula('VOLUME * [PRICE]');
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /\[VOLUME\]/);
});

test('flags unclosed and empty references', () => {
  assert.equal(parseFormula('[VOLUME * [PRICE]').ok, false);
  assert.equal(parseFormula('[VOLUME').ok, false);
  assert.equal(parseFormula('[] + 1').ok, false);
});

test('empty formula is neither ok nor an error list', () => {
  const r = parseFormula('   ');
  assert.equal(r.isEmpty, true);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 0);
});

test('function calls with nested expressions', () => {
  const r = parseFormula('MAX([A], [B] * 2, MIN([C], 0))');
  assert.equal(r.ok, true);
  assert.equal(r.ast.type, 'call');
  assert.equal(r.ast.name, 'MAX');
  assert.equal(r.ast.args.length, 3);
  assert.deepEqual(collectAstReferences(r.ast).map((x) => x.token), ['A', 'B', 'C']);
});

test('formatReference round-trips through parseReferenceBody', () => {
  const ref = { token: 'REVENUE', scenarioCode: 'TT', dimensionContext: [{ dimension: 'Product', member: 'HRC' }] };
  const text = formatReference(ref);
  assert.equal(text, '[TT:REVENUE | Product=HRC]');
  const parsed = parseReferenceBody(text.slice(1, -1));
  assert.equal(parsed.token, 'REVENUE');
  assert.equal(parsed.scenarioCode, 'TT');
  assert.deepEqual(parsed.dimensionContext, ref.dimensionContext);
});

test('distinctReferences dedupes by scenario + token (case-insensitive)', () => {
  const refs = extractReferences('[a] + [A] + [TT:a] + [b]');
  assert.equal(distinctReferences(refs).length, 3);
});

test('unary minus and power', () => {
  const r = parseFormula('-[A] ^ 2 + +[B]');
  assert.equal(r.ok, true);
  assert.equal(r.ast.left.type, 'unary');
  assert.equal(r.ast.left.operand.op, '^');
});
