import * as ts from "/Users/konata/code/tmex-enhanced-wt-r6/node_modules/typescript/lib/typescript.js";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? ".";
const threshold = Number(process.argv[3] ?? 15);
const files: string[] = [];
function walk(d: string) {
  for (const e of readdirSync(d)) {
    if (["node_modules", "dist", "fe-dist", ".git", "resources"].includes(e)) continue;
    const p = join(d, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.|\.spec\.|\.d\.ts$/.test(e) && !p.includes("/i18n/")) files.push(p);
  }
}
walk(root);
type Row = { file: string; name: string; line: number; cc: number; lines: number };
const rows: Row[] = [];
for (const f of files) {
  const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visitFn = (node: ts.Node, name: string) => {
    let cc = 1;
    const count = (n: ts.Node) => {
      if (n !== node && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n))) return;
      switch (n.kind) {
        case ts.SyntaxKind.IfStatement: case ts.SyntaxKind.ConditionalExpression: case ts.SyntaxKind.CaseClause:
        case ts.SyntaxKind.ForStatement: case ts.SyntaxKind.ForInStatement: case ts.SyntaxKind.ForOfStatement:
        case ts.SyntaxKind.WhileStatement: case ts.SyntaxKind.DoStatement: case ts.SyntaxKind.CatchClause: cc++; break;
        case ts.SyntaxKind.BinaryExpression: {
          const op = (n as ts.BinaryExpression).operatorToken.kind;
          if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) cc++;
          break;
        }
      }
      ts.forEachChild(n, count);
    };
    count(node);
    const s = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const e = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    rows.push({ file: f, name, line: s, cc, lines: e - s + 1 });
  };
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) visitFn(n, n.name?.getText() ?? "<anon>");
    else if ((ts.isFunctionExpression(n) || ts.isArrowFunction(n)) && n.parent && ts.isVariableDeclaration(n.parent)) visitFn(n, n.parent.name.getText());
    else if ((ts.isFunctionExpression(n) || ts.isArrowFunction(n)) && n.body && ts.isBlock(n.body) && n.body.statements.length > 15) visitFn(n, "<anon>");
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
const hi = rows.filter((r) => r.cc > threshold).sort((a, b) => b.cc - a.cc);
console.log(`functions CC>${threshold}: ${hi.length}; CC>30: ${rows.filter((r) => r.cc > 30).length}; >80 lines: ${rows.filter((r) => r.lines > 80).length}`);
for (const r of hi) console.log(`${r.cc}\t${r.lines}L\t${r.file}:${r.line}\t${r.name}`);
if (process.argv[4] === "big") {
  console.log("--- >80 lines:");
  for (const r of rows.filter((r) => r.lines > 80).sort((a, b) => b.lines - a.lines)) console.log(`${r.lines}L\tcc=${r.cc}\t${r.file}:${r.line}\t${r.name}`);
}
