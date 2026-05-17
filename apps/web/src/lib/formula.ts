// Tiny formula evaluator: supports number/string literals, prop("Name"),
// + - * / %, concat(a, b), if(cond, a, b), and parens.
// Not safe for arbitrary user input on the server — keep evaluation client-side.

import type { DbProp } from "./database";

type Row = { title: string; dataValues: Record<string, unknown> };

type Token =
  | { type: "num"; v: number }
  | { type: "str"; v: string }
  | { type: "ident"; v: string }
  | { type: "op"; v: string }
  | { type: "lp" | "rp" | "comma" };

function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(") { out.push({ type: "lp" }); i++; continue; }
    if (c === ")") { out.push({ type: "rp" }); i++; continue; }
    if (c === ",") { out.push({ type: "comma" }); i++; continue; }
    if ("+-*/%".includes(c)) { out.push({ type: "op", v: c }); i++; continue; }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      let buf = "";
      while (j < s.length && s[j] !== q) {
        if (s[j] === "\\" && j + 1 < s.length) {
          buf += s[j + 1];
          j += 2;
        } else {
          buf += s[j];
          j++;
        }
      }
      out.push({ type: "str", v: buf });
      i = j + 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      out.push({ type: "num", v: Number(s.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      out.push({ type: "ident", v: s.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected char: ${c}`);
  }
  return out;
}

class Parser {
  i = 0;
  constructor(public tokens: Token[]) {}
  peek(): Token | undefined { return this.tokens[this.i]; }
  consume(): Token { return this.tokens[this.i++]; }
  expect(type: Token["type"]) {
    const t = this.consume();
    if (!t || t.type !== type) throw new Error(`Expected ${type}, got ${t?.type}`);
    return t;
  }
  // expr = term (('+'|'-') term)*
  expr(): Node {
    let left = this.term();
    while (this.peek()?.type === "op" && (this.peek() as { v: string }).v.match(/[+\-]/)) {
      const op = (this.consume() as { v: string }).v;
      const right = this.term();
      left = { kind: "bin", op, a: left, b: right };
    }
    return left;
  }
  // term = factor (('*'|'/'|'%') factor)*
  term(): Node {
    let left = this.factor();
    while (this.peek()?.type === "op" && (this.peek() as { v: string }).v.match(/[*/%]/)) {
      const op = (this.consume() as { v: string }).v;
      const right = this.factor();
      left = { kind: "bin", op, a: left, b: right };
    }
    return left;
  }
  factor(): Node {
    const t = this.peek();
    if (!t) throw new Error("Unexpected end");
    if (t.type === "num") { this.consume(); return { kind: "num", v: t.v }; }
    if (t.type === "str") { this.consume(); return { kind: "str", v: t.v }; }
    if (t.type === "lp") {
      this.consume();
      const e = this.expr();
      this.expect("rp");
      return e;
    }
    if (t.type === "ident") {
      this.consume();
      if (this.peek()?.type === "lp") {
        this.consume();
        const args: Node[] = [];
        if (this.peek()?.type !== "rp") {
          args.push(this.expr());
          while (this.peek()?.type === "comma") {
            this.consume();
            args.push(this.expr());
          }
        }
        this.expect("rp");
        return { kind: "call", name: t.v, args };
      }
      return { kind: "ident", name: t.v };
    }
    throw new Error(`Unexpected token: ${t.type}`);
  }
}

type Node =
  | { kind: "num"; v: number }
  | { kind: "str"; v: string }
  | { kind: "ident"; name: string }
  | { kind: "bin"; op: string; a: Node; b: Node }
  | { kind: "call"; name: string; args: Node[] };

function evalNode(n: Node, row: Row, props: DbProp[]): unknown {
  switch (n.kind) {
    case "num": return n.v;
    case "str": return n.v;
    case "ident":
      // bare identifier "true"/"false" or column shorthand
      if (n.name === "true") return true;
      if (n.name === "false") return false;
      return resolveProp(n.name, row, props);
    case "bin": {
      const a = evalNode(n.a, row, props);
      const b = evalNode(n.b, row, props);
      if (n.op === "+") {
        if (typeof a === "string" || typeof b === "string") return String(a ?? "") + String(b ?? "");
        return Number(a) + Number(b);
      }
      if (n.op === "-") return Number(a) - Number(b);
      if (n.op === "*") return Number(a) * Number(b);
      if (n.op === "/") return Number(a) / Number(b);
      if (n.op === "%") return Number(a) % Number(b);
      return null;
    }
    case "call": {
      const args = n.args.map((x) => evalNode(x, row, props));
      switch (n.name) {
        case "prop": return resolveProp(String(args[0] ?? ""), row, props);
        case "concat": return args.map((x) => String(x ?? "")).join("");
        case "if": return args[0] ? args[1] : args[2];
        case "length": return String(args[0] ?? "").length;
        case "number": return Number(args[0]);
        case "string": return String(args[0] ?? "");
        case "sum": return args.reduce((a, b) => Number(a) + Number(b), 0);
        case "min": return Math.min(...args.map(Number));
        case "max": return Math.max(...args.map(Number));
        default: return null;
      }
    }
  }
}

function resolveProp(name: string, row: Row, props: DbProp[]): unknown {
  if (name === "title" || name === "Name") return row.title;
  const p = props.find((pp) => pp.name === name);
  if (!p) return null;
  if (p.id === "p_title") return row.title;
  return row.dataValues[p.id] ?? null;
}

export function evalFormula(expr: string, row: Row, props: DbProp[]): unknown {
  if (!expr.trim()) return null;
  try {
    const tokens = tokenize(expr);
    const parser = new Parser(tokens);
    const ast = parser.expr();
    return evalNode(ast, row, props);
  } catch (e) {
    return `#err: ${(e as Error).message}`;
  }
}
