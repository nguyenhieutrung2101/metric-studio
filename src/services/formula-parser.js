/**
 * FormulaParser
 *
 *   formula text → tokens → AST → structured metric references
 *
 * Phase 1 grammar (readable references, arithmetic, function calls):
 *
 *   expression := additive
 *   additive   := multiplicative (('+' | '-') multiplicative)*
 *   multiplicative := unary (('*' | '/') unary)*
 *   unary      := ('-' | '+') unary | power
 *   power      := primary ('^' unary)?
 *   primary    := NUMBER | REFERENCE | '(' expression ')' | IDENT '(' [args] ')'
 *   args       := expression (',' expression)*
 *
 *   REFERENCE  := '[' [scenario ':'] identifier ['|' context] ']'
 *     scenario   : short code such as TT or GD (validated by the resolver, not here)
 *     identifier : metric code, alias or exact name (spaces allowed)
 *     context    : key=value (';' key=value)*   — reserved for dimension context
 *
 * The parser is deliberately independent of the store: it produces
 * references with raw tokens and the binding service resolves them.
 * References are extracted from tokens even when the expression has a syntax
 * error, so the UI can still show what a broken formula tried to reference.
 */

import { referenceKey } from '../utils/text.js';

const OPERATORS = new Set(['+', '-', '*', '/', '^']);

export function tokenize(text) {
  const src = String(text ?? '');
  const tokens = [];
  const errors = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }

    if (ch === '[') {
      const close = src.indexOf(']', i + 1);
      if (close === -1) {
        errors.push({ message: 'Unclosed reference: missing "]"', position: i });
        tokens.push({ type: 'error', value: src.slice(i), start: i, end: n });
        break;
      }
      const inner = src.slice(i + 1, close);
      const ref = parseReferenceBody(inner);
      if (!ref.token) errors.push({ message: 'Empty reference "[]"', position: i });
      else if (inner.includes('[')) errors.push({ message: `Nested "[" inside reference "[${inner}]" — missing "]"?`, position: i });
      tokens.push({ type: 'reference', value: inner, ref, start: i, end: close + 1 });
      i = close + 1;
      continue;
    }

    if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1]))) {
      let j = i;
      while (j < n && (isDigit(src[j]) || src[j] === '.')) j += 1;
      let raw = src.slice(i, j);
      let percent = false;
      if (src[j] === '%') {
        percent = true;
        j += 1;
      }
      if ((raw.match(/\./g) || []).length > 1) errors.push({ message: `Invalid number "${raw}"`, position: i });
      tokens.push({ type: 'number', value: Number(raw) * (percent ? 0.01 : 1), raw: src.slice(i, j), percent, start: i, end: j });
      i = j;
      continue;
    }

    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j += 1;
      tokens.push({ type: 'ident', value: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }

    if (OPERATORS.has(ch)) {
      tokens.push({ type: 'op', value: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen', value: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }

    errors.push({ message: `Unexpected character "${ch}"`, position: i });
    tokens.push({ type: 'error', value: ch, start: i, end: i + 1 });
    i += 1;
  }

  return { tokens, errors };
}

/** Parse the inside of [...] into { token, scenarioCode, dimensionContext }. */
export function parseReferenceBody(inner) {
  let body = String(inner ?? '').trim();
  let dimensionContext = null;
  const pipe = body.indexOf('|');
  if (pipe !== -1) {
    dimensionContext = parseDimensionContext(body.slice(pipe + 1));
    body = body.slice(0, pipe).trim();
  }
  let scenarioCode = null;
  const m = body.match(/^([A-Za-z][A-Za-z0-9_]{0,7})\s*:\s*(.+)$/);
  if (m) {
    scenarioCode = m[1].toUpperCase();
    body = m[2].trim();
  }
  return { token: body, scenarioCode, dimensionContext };
}

function parseDimensionContext(text) {
  const pairs = [];
  for (const part of String(text).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      const key = part.trim();
      if (key) pairs.push({ dimension: key, member: null });
      continue;
    }
    pairs.push({ dimension: part.slice(0, eq).trim(), member: part.slice(eq + 1).trim() });
  }
  return pairs.length ? pairs : null;
}

/** Textual form of a reference, e.g. formatReference({ token: 'REVENUE', scenarioCode: 'TT' }) → "[TT:REVENUE]". */
export function formatReference({ token, scenarioCode = null, dimensionContext = null }) {
  let out = scenarioCode ? `${scenarioCode}:${token}` : token;
  if (dimensionContext && dimensionContext.length) {
    out += ' | ' + dimensionContext.map((p) => (p.member == null ? p.dimension : `${p.dimension}=${p.member}`)).join('; ');
  }
  return `[${out}]`;
}

/**
 * Full parse. Always returns references (from tokens) and errors; `ast` is
 * null when the expression is not well formed.
 */
export function parseFormula(text) {
  const { tokens, errors } = tokenize(text);
  const references = tokens
    .filter((t) => t.type === 'reference')
    .map((t) => ({ raw: `[${t.value}]`, token: t.ref.token, scenarioCode: t.ref.scenarioCode, dimensionContext: t.ref.dimensionContext, start: t.start, end: t.end }));

  const isEmpty = tokens.length === 0;
  let ast = null;
  if (!isEmpty && errors.length === 0) {
    const parser = new Parser(tokens.filter((t) => t.type !== 'error'));
    try {
      ast = parser.parseExpression();
      if (parser.pos < parser.tokens.length) {
        const t = parser.tokens[parser.pos];
        throw new ParseError(`Unexpected "${t.raw || t.value}"`, t.start);
      }
    } catch (err) {
      if (err instanceof ParseError) {
        errors.push({ message: err.message, position: err.position });
        ast = null;
      } else {
        throw err;
      }
    }
  }
  return { ok: !isEmpty && errors.length === 0 && ast !== null, isEmpty, ast, references, errors, tokens };
}

/** Convenience: references only. */
export function extractReferences(text) {
  return parseFormula(text).references;
}

/**
 * Identity of a reference: scenario, metric token and dimension context.
 *
 * [REVENUE | Product=HRC] and [REVENUE | Product=Car] are two different
 * inputs to a formula, so they must not collapse into one. The token is
 * normalised exactly the way references are resolved to metrics
 * (`referenceKey`, so case, spacing and diacritics do not matter), which
 * keeps "two references" and "two metrics" from ever disagreeing.
 *
 * This is the single definition of reference identity: the parser, the
 * validation rules and the dependency graph all use it.
 */
export function referenceIdentity(r) {
  const ctx = (r.dimensionContext || [])
    .map((p) => `${referenceKey(p.dimension)}=${p.member == null ? '' : referenceKey(p.member)}`)
    .sort()
    .join(';');
  return `${(r.scenarioCode || '').toUpperCase()}:${referenceKey(r.token)}:${ctx}`;
}

/** Distinct references in order of first appearance. */
export function distinctReferences(references) {
  const seen = new Set();
  const out = [];
  for (const r of references) {
    const key = referenceIdentity(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

class ParseError extends Error {
  constructor(message, position) {
    super(message);
    this.position = position;
  }
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    return this.tokens[this.pos++];
  }

  accept(type, value) {
    const t = this.peek();
    if (t && t.type === type && (value === undefined || t.value === value)) {
      this.pos += 1;
      return t;
    }
    return null;
  }

  expect(type, value, what) {
    const t = this.accept(type, value);
    if (!t) {
      const cur = this.peek();
      const pos = cur ? cur.start : (this.tokens.length ? this.tokens[this.tokens.length - 1].end : 0);
      throw new ParseError(cur ? `Expected ${what} but found "${cur.raw || cur.value}"` : `Expected ${what} but reached end of formula`, pos);
    }
    return t;
  }

  parseExpression() {
    return this.parseAdditive();
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    for (;;) {
      const t = this.peek();
      if (t && t.type === 'op' && (t.value === '+' || t.value === '-')) {
        this.pos += 1;
        const right = this.parseMultiplicative();
        left = { type: 'binary', op: t.value, left, right };
      } else return left;
    }
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t && t.type === 'op' && (t.value === '*' || t.value === '/')) {
        this.pos += 1;
        const right = this.parseUnary();
        left = { type: 'binary', op: t.value, left, right };
      } else return left;
    }
  }

  parseUnary() {
    const t = this.peek();
    if (t && t.type === 'op' && (t.value === '-' || t.value === '+')) {
      this.pos += 1;
      return { type: 'unary', op: t.value, operand: this.parseUnary() };
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePrimary();
    if (this.accept('op', '^')) {
      const exponent = this.parseUnary();
      return { type: 'binary', op: '^', left: base, right: exponent };
    }
    return base;
  }

  parsePrimary() {
    const t = this.peek();
    if (!t) throw new ParseError('Unexpected end of formula', this.tokens.length ? this.tokens[this.tokens.length - 1].end : 0);
    if (t.type === 'number') {
      this.pos += 1;
      return { type: 'number', value: t.value, raw: t.raw };
    }
    if (t.type === 'reference') {
      this.pos += 1;
      return { type: 'reference', token: t.ref.token, scenarioCode: t.ref.scenarioCode, dimensionContext: t.ref.dimensionContext, raw: `[${t.value}]` };
    }
    if (t.type === 'lparen') {
      this.pos += 1;
      const inner = this.parseExpression();
      this.expect('rparen', undefined, '")"');
      return { type: 'group', expression: inner };
    }
    if (t.type === 'ident') {
      this.pos += 1;
      if (this.accept('lparen')) {
        const args = [];
        if (!this.accept('rparen')) {
          args.push(this.parseExpression());
          while (this.accept('comma')) args.push(this.parseExpression());
          this.expect('rparen', undefined, '")"');
        }
        return { type: 'call', name: t.value.toUpperCase(), args };
      }
      throw new ParseError(`Unknown identifier "${t.value}". Metric references must be written in brackets, e.g. [${t.value}]`, t.start);
    }
    if (t.type === 'op' || t.type === 'rparen' || t.type === 'comma') {
      throw new ParseError(`Unexpected "${t.value}"`, t.start);
    }
    throw new ParseError(`Unexpected token "${t.value}"`, t.start);
  }
}

/** Walk an AST and collect reference nodes (used by tests and tooling). */
export function collectAstReferences(ast, out = []) {
  if (!ast) return out;
  switch (ast.type) {
    case 'reference':
      out.push(ast);
      break;
    case 'binary':
      collectAstReferences(ast.left, out);
      collectAstReferences(ast.right, out);
      break;
    case 'unary':
      collectAstReferences(ast.operand, out);
      break;
    case 'group':
      collectAstReferences(ast.expression, out);
      break;
    case 'call':
      for (const a of ast.args) collectAstReferences(a, out);
      break;
    default:
      break;
  }
  return out;
}

function isDigit(c) {
  return c >= '0' && c <= '9';
}
function isIdentStart(c) {
  return /[A-Za-z_À-ɏḀ-ỿ]/.test(c);
}
function isIdentPart(c) {
  return /[A-Za-z0-9_.À-ɏḀ-ỿ]/.test(c);
}
