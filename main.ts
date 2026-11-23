// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves the edits made, in order, for the `R` lines of section 2. */
  readonly moves: { from: string; to: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 3: a file as lines, its own line break, and whether it ends with one ----

interface FileText {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitText(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function joinText(f: FileText): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.fin ? f.br : '');
}

// ---- Section 5: matching lines at three tiers ----

const stripTrailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailWs(a) === stripTrailWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

function tiersOf(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Every position at or after `from` where o's lines match the file's lines at `tier`; occurrences may overlap. */
function occAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
}

/** O (context and `-` lines), N (context and `+` lines), and for each line of N the index into O when it is a context line. */
function buildON(body: BodyLine[]): { o: string[]; n: string[]; ctx: (number | null)[] } {
  const o: string[] = [];
  const n: string[] = [];
  const ctx: (number | null)[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      ctx.push(o.length);
      o.push(b.text);
      n.push(b.text);
    } else if (b.kind === '-') {
      o.push(b.text);
    } else {
      ctx.push(null);
      n.push(b.text);
    }
  }
  return { o, n, ctx };
}

/**
 * The lines N becomes over the match at `pos`: a context line is written as the file's own matched line, and at
 * tier 2 every other line of N is re-indented from O's first line's lead to the file's first matched line's lead.
 */
function written(o: string[], n: string[], ctx: (number | null)[], fileLines: string[], pos: number, tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(fileLines[pos]!);
    p = leadWs(o[0]!);
  }
  return n.map((line, j) => {
    const c = ctx[j]!;
    if (c !== null) return fileLines[pos + c]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) return f + line.slice(p.length);
    return line;
  });
}

// ---- Section 6: unified diffs ----

interface RawLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  empty: boolean;
}

interface UHunk {
  a: number;
  raw: RawLine[];
  bsPlus: boolean;
  bsCtxPlus: boolean;
}

interface USection {
  gitOld?: string;
  gitNew?: string;
  hdrOld?: string | null;
  hdrNew?: string | null;
  renOld?: string;
  renNew?: string;
  isNew: boolean;
  isDel: boolean;
  hunks: UHunk[];
  sawPair: boolean;
}

/** The path a `---` or `+++` line names: up to the first tab, spaces removed, `/dev/null` as null, a leading `a/` or `b/` removed. */
function hdrPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return t.replace(/^[ab]\//, '');
}

function gitPaths(line: string, lineNo: number): { x: string; y: string } {
  const rest = line.slice('diff --git '.length);
  const at = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
  if (at < 0) throw new Exit2(`error: parse ${lineNo}`);
  const x = rest.slice(2, at);
  const y = rest.slice(at + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${lineNo}`);
  return { x, y };
}

/** Whether a `\` line follows the body's last `+` line, and its last context or `+` line. */
function bsFlags(raw: RawLine[]): { bsPlus: boolean; bsCtxPlus: boolean } {
  let lastPlus = -1;
  let lastCtxPlus = -1;
  raw.forEach((b, idx) => {
    if (b.kind === '+') {
      lastPlus = idx;
      lastCtxPlus = idx;
    } else if (b.kind === ' ') lastCtxPlus = idx;
  });
  return {
    bsPlus: lastPlus >= 0 && raw[lastPlus + 1]?.kind === '\\',
    bsCtxPlus: lastCtxPlus >= 0 && raw[lastCtxPlus + 1]?.kind === '\\',
  };
}

function applyUnifiedHunks(f: FileText, hunks: UHunk[], path: string, strict: boolean): void {
  let d = 0;
  const tiers = tiersOf(strict);
  for (const h of hunks) {
    const body = h.raw.filter((b) => b.kind !== '\\') as BodyLine[];
    const { o, n, ctx } = buildON(body);
    if (o.length === 0) {
      const lenBefore = f.lines.length;
      const pos = Math.max(0, Math.min(h.a + d, lenBefore));
      f.lines.splice(pos, 0, ...n);
      if (pos === lenBefore) f.fin = !h.bsPlus;
    } else {
      let tierUsed = -1;
      let occ: number[] = [];
      for (const t of tiers) {
        occ = occAt(f.lines, o, t, 0);
        if (occ.length > 0) {
          tierUsed = t;
          break;
        }
      }
      if (tierUsed < 0) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = occ[0]!;
      for (const c of occ) if (Math.abs(c - target) < Math.abs(pos - target)) pos = c;
      const w = written(o, n, ctx, f.lines, pos, tierUsed);
      const atEnd = pos + o.length === f.lines.length;
      f.lines.splice(pos, o.length, ...w);
      if (atEnd) f.fin = !h.bsCtxPlus;
    }
    d += n.length - o.length;
  }
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.hdrOld !== undefined ? sec.hdrOld : sec.renOld !== undefined ? sec.renOld : sec.gitOld;
    const newP = sec.hdrNew !== undefined ? sec.hdrNew : sec.renNew !== undefined ? sec.renNew : sec.gitNew;
    if (sec.isNew || oldP === null) {
      const p = newP as string;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let fin = true;
      for (const h of sec.hunks) {
        h.raw.forEach((b, idx) => {
          if (b.kind === '+') {
            out.push(b.text);
            fin = h.raw[idx + 1]?.kind !== '\\';
          }
        });
      }
      tree.now.set(p, joinText({ lines: out, br: '\n', fin }));
      return;
    }
    if (sec.isDel || newP === null) {
      const p = oldP as string;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldP as string;
    const n = newP as string;
    if (!safe(o)) throw new Fail('unsafe', o);
    if (n !== o && !safe(n)) throw new Fail('unsafe', n);
    const before = tree.get(o);
    if (before === null) throw new Fail('missing', o);
    if (n !== o && tree.get(n) !== null) throw new Fail('exists', n);
    const f = splitText(before);
    applyUnifiedHunks(f, sec.hunks, o, strict);
    tree.now.set(n, joinText(f));
    if (n !== o) {
      tree.now.set(o, null);
      tree.moves.push({ from: o, to: n });
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const newSection = (): USection => {
    const s: USection = { isNew: false, isDel: false, hunks: [], sawPair: false };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const raw: RawLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') raw.push({ kind: ' ', text: '', empty: true });
        else if (bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') raw.push({ kind: bl[0] as RawLine['kind'], text: bl.slice(1), empty: false });
        else break;
        j += 1;
      }
      while (raw.length > 0 && raw[raw.length - 1]!.empty) raw.pop();
      cur.hunks.push({ a: Number(m[1]), raw, ...bsFlags(raw) });
      i = j;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const { x, y } = gitPaths(line, i + 1);
      const s = newSection();
      s.gitOld = x;
      s.gitNew = y;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && !cur.sawPair) {
        cur.hdrOld = hdrPath(line.slice(4));
        cur.hdrNew = hdrPath(lines[i + 1]!.slice(4));
        cur.sawPair = true;
      } else {
        const s = newSection();
        s.hdrOld = hdrPath(line.slice(4));
        s.hdrNew = hdrPath(lines[i + 1]!.slice(4));
        s.sawPair = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDel = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function srBlockEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinText({ lines: [...newLines], br: '\n', fin: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitText(before);
    let tierUsed = -1;
    let occ: number[] = [];
    for (const t of tiersOf(strict)) {
      occ = occAt(f.lines, oldLines, t, 0);
      if (occ.length > 0) {
        tierUsed = t;
        break;
      }
    }
    if (tierUsed < 0) throw new Fail('no-match', path);
    if (occ.length > 1) throw new Fail('ambiguous', path);
    const pos = occ[0]!;
    const w = written(oldLines, newLines, newLines.map(() => null), f.lines, pos, tierUsed);
    f.lines.splice(pos, oldLines.length, ...w);
    tree.now.set(path, joinText(f));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let regionStart = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let k = searchLine - 1; k >= regionStart; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srBlockEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    regionStart = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'del' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
  lineNo: number;
}

function parseVSection(kind: VSection['kind'], path: string, lineNo: number, raw: { text: string; no: number }[]): VSection {
  const sec: VSection = { kind, path, moveTo: null, addLines: [], chunks: [], lineNo };
  if (kind === 'add') {
    for (const r of raw) {
      if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
      else if (r.text === '') sec.addLines.push('');
      else throw new Exit2(`error: parse ${r.no}`);
    }
    return sec;
  }
  if (kind === 'del') {
    for (const r of raw) if (r.text !== '') throw new Exit2(`error: parse ${r.no}`);
    return sec;
  }
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to:')) {
    sec.moveTo = raw[0]!.text.slice('*** Move to:'.length).trim();
    idx = 1;
  }
  let chunk: VChunk | null = null;
  let chunkCount = 0;
  for (; idx < raw.length; idx += 1) {
    const r = raw[idx]!;
    const l = r.text;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      sec.chunks.push(chunk);
      chunkCount += 1;
    } else if (l === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${r.no}`);
      chunk.eof = true;
      chunk = null;
    } else if (l.startsWith('*** ')) {
      throw new Exit2(`error: parse ${r.no}`);
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (chunk === null) {
        if (chunkCount > 0) throw new Exit2(`error: parse ${r.no}`);
        chunk = { anchor: null, eof: false, body: [] };
        sec.chunks.push(chunk);
        chunkCount += 1;
      }
      chunk.body.push({ kind: l === '' ? ' ' : (l[0] as BodyLine['kind']), text: l === '' ? '' : l.slice(1) });
    } else {
      throw new Exit2(`error: parse ${r.no}`);
    }
  }
  if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${lineNo}`);
  return sec;
}

function applyVChunks(f: FileText, chunks: VChunk[], path: string, strict: boolean): void {
  const tiers = tiersOf(strict);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let found = -1;
      for (const t of tiers) {
        for (let k = cursor; k < f.lines.length; k += 1) {
          if (lineEq(f.lines[k]!, ch.anchor, t)) {
            found = k;
            break;
          }
        }
        if (found >= 0) break;
      }
      if (found < 0) throw new Fail('no-match', path);
      cursor = found + 1;
    }
    const { o, n, ctx } = buildON(ch.body);
    if (o.length === 0) {
      const pos = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
      f.lines.splice(pos, 0, ...n);
      cursor = pos + n.length;
      continue;
    }
    let tierUsed = -1;
    let pos = -1;
    for (const t of tiers) {
      const occ = occAt(f.lines, o, t, cursor).filter((c) => !ch.eof || c + o.length === f.lines.length);
      if (occ.length > 0) {
        tierUsed = t;
        pos = occ[0]!;
        break;
      }
    }
    if (pos < 0) throw new Fail('no-match', path);
    const w = written(o, n, ctx, f.lines, pos, tierUsed);
    f.lines.splice(pos, o.length, ...w);
    cursor = pos + w.length;
  }
}

function v4aSectionEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, joinText({ lines: [...sec.addLines], br: '\n', fin: true }));
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const target = sec.moveTo;
    if (target !== null && !safe(target)) throw new Fail('unsafe', target);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (target !== null && tree.get(target) !== null) throw new Fail('exists', target);
    const f = splitText(before);
    applyVChunks(f, sec.chunks, p, strict);
    tree.now.set(target ?? p, joinText(f));
    if (target !== null) {
      tree.now.set(p, null);
      tree.moves.push({ from: p, to: target });
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k])) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = (l: string): VSection['kind'] | null =>
    l.startsWith('*** Add File:') ? 'add' : l.startsWith('*** Delete File:') ? 'del' : l.startsWith('*** Update File:') ? 'update' : null;
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = secStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(line.indexOf(':') + 1).trim();
    const raw: { text: string; no: number }[] = [];
    let j = i + 1;
    while (j < last && secStart(lines[j]!) === null) {
      raw.push({ text: lines[j]!, no: j + 1 });
      j += 1;
    }
    while (raw.length > 0 && raw[raw.length - 1]!.text.trim() === '') raw.pop();
    sections.push(parseVSection(kind, path, i + 1, raw));
    i = j;
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // A move whose old path is gone and whose new path is new prints as one `R` line, sorted by the new path (section 2).
  const rows: { key: string; text: string }[] = [];
  const inMove = new Set<string>();
  for (const mv of tree.moves) {
    const wasFrom = tree.original(mv.from);
    const nowFrom = tree.now.has(mv.from) ? tree.now.get(mv.from)! : wasFrom;
    const wasTo = tree.original(mv.to);
    const nowTo = tree.now.has(mv.to) ? tree.now.get(mv.to)! : wasTo;
    if (wasFrom !== null && nowFrom === null && wasTo === null && nowTo !== null) {
      rows.push({ key: mv.to, text: `R ${mv.from} -> ${mv.to}` });
      inMove.add(mv.from);
      inMove.add(mv.to);
    }
  }
  for (const p of changed) {
    if (inMove.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
