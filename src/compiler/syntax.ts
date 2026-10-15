export class Diagnostic extends Error {
  constructor(public code: string, public line: number, public detail: string, public hint = '') {
    super(`${code} · 第 ${line} 行：${detail}${hint ? '\n建议：' + hint : ''}`);
  }
  toJSON() { return { code: this.code, line: this.line, column: 1, message: this.detail, hint: this.hint }; }
}
export function fail(code: string, line: number, message: string, hint = ''): never { throw new Diagnostic(code, line, message, hint); }
export interface Line { text: string; number: number; block: boolean; children: Line[]; mark?: string }
export class Seconds { constructor(public value: number) {} }
export interface Call { call: string; args: Value[]; kwargs: Record<string, Value> }
export type Value = string | number | boolean | Seconds | Value[] | Call;
export const identifier = (s: string) => /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(s);
export const isCall = (v: unknown): v is Call => !!v && typeof v === 'object' && 'call' in v;
export class Tokens {
  items: string[] = []; i = 0;
  constructor(text: string, public line: number) {
    const pattern = /\s*("(?:\\.|[^"\\])*"|>=|(?:\d+(?:\.\d+)?)(?:s)?|[_\p{ID_Start}][_\p{ID_Continue}]*|[=(),.\[\]@-])/uy;
    let p = 0;
    while (p < text.length) {
      pattern.lastIndex = p; const m = pattern.exec(text);
      if (!m) { if (!text.slice(p).trim()) break; fail('E_TOKEN', line, `无法识别 ${text.slice(p)}`); }
      this.items.push(m[1]); p = pattern.lastIndex;
    }
  }
  peek() { return this.items[this.i]; }
  pop(want?: string): string { const t = this.peek(); if (t === undefined || want !== undefined && t !== want) fail('E_SYNTAX', this.line, `需要 ${want || '内容'}，实际为 ${t || '行尾'}`); this.i++; return t; }
  done() { if (this.peek() !== undefined) fail('E_SYNTAX', this.line, `多余内容：${this.items.slice(this.i).join(' ')}`); }
  value(): Value {
    const t = this.pop();
    if (t === '-') { const v = this.value(); if (typeof v !== 'number') fail('E_VALUE', this.line, '负号后必须为数字'); return -v; }
    if (t.startsWith('"')) { try { return JSON.parse(t); } catch { fail('E_STRING', this.line, '字符串转义不正确'); } }
    if (/^\d+(\.\d+)?s$/.test(t)) return new Seconds(Number(t.slice(0, -1)));
    if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
    if (t === '[') { const values: Value[] = []; while (this.peek() !== ']') { values.push(this.value()); if (this.peek() !== ']') this.pop(','); } this.pop(']'); return values; }
    if (t === 'true' || t === 'false') return t === 'true';
    if (!identifier(t)) fail('E_VALUE', this.line, `无效名称 ${t}`);
    if (this.peek() !== '(') return t;
    this.pop('('); const args: Value[] = []; const kwargs: Record<string, Value> = Object.create(null);
    while (this.peek() !== ')') {
      if (this.items[this.i + 1] === '=') {
        const k = this.pop(); this.pop('='); if (Object.hasOwn(kwargs, k)) fail('E_DUPLICATE_PARAM', this.line, `重复参数 ${k}`); kwargs[k] = this.value();
      } else { if (Object.keys(kwargs).length) fail('E_SYNTAX', this.line, '位置参数不能出现在关键字参数后'); args.push(this.value()); }
      if (this.peek() !== ')') this.pop(',');
    }
    this.pop(')'); return { call: t, args, kwargs };
  }
  options() { const result: Record<string, Value> = Object.create(null); while (this.peek() !== undefined) { const k = this.pop(); this.pop('='); if (Object.hasOwn(result, k)) fail('E_DUPLICATE_PARAM', this.line, `重复参数 ${k}`); result[k] = this.value(); } return result; }
}
export function lines(source: string): Line[] {
  const root: Line[] = [], stack: { indent: number; children: Line[] }[] = [{ indent: -1, children: root }];
  source.normalize('NFC').replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).forEach((input, index) => {
    const number = index + 1;
    if (input.includes('\t')) fail('E_INDENT', number, '请使用空格，不使用 Tab');
    let quoted = false, escape = false, end = input.length;
    for (let i = 0; i < input.length; i++) { const c = input[i]; if (escape) { escape = false; continue; } if (quoted && c === '\\') { escape = true; continue; } if (c === '"') quoted = !quoted; if (c === '#' && !quoted) { end = i; break; } }
    const raw = input.slice(0, end).trimEnd(); if (!raw.trim()) return;
    if (quoted) fail('E_STRING', number, '双引号字符串未闭合');
    const indent = raw.length - raw.trimStart().length, text = raw.trim();
    if (indent % 4) fail('E_INDENT', number, '每层缩进必须是 4 个空格');
    while (stack.length > 1 && indent <= stack.at(-1)!.indent) stack.pop();
    if (indent !== (stack.at(-1)!.indent === -1 ? 0 : stack.at(-1)!.indent + 4)) fail('E_INDENT', number, '块缩进不正确', 'failed/insufficient/rejected 应与所属动作同级');
    const block = text.endsWith(':'), n: Line = { text: block ? text.slice(0, -1).trimEnd() : text, number, block, children: [] };
    stack.at(-1)!.children.push(n); if (block) stack.push({ indent, children: n.children });
  }); return root;
}
export function keys(d: object, allowed: string[], line: number) { const extra = Object.keys(d).filter(k => !allowed.includes(k)); if (extra.length) fail('E_PARAM', line, '未知参数 ' + extra.sort().join(', ')); }
export function number(v: unknown, line: number, name: string, lo: number, hi: number, seconds = false): number {
  if (seconds) { if (!(v instanceof Seconds)) fail('E_UNIT', line, `${name} 必须带秒单位 s`); v = v.value; }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) fail('E_RANGE', line, `${name} 必须在 ${lo}～${hi} 范围内`); return v;
}
