#!/usr/bin/env bun
/**
 * Type-aware enforcement that handlers preserve an AdapterResult's typed `code`
 * when they relay an `ok:false` result (#534, follow-up to #527).
 *
 * WHY THIS EXISTS — and its relationship to gate-greps.sh #3
 * ---------------------------------------------------------------------------
 * gate-greps.sh #3 is a HEURISTIC: a single-line grep keyed to the `result`
 * variable name. A grep cannot tell an `AdapterResult<T>` (whose `ok:false` arm
 * carries a REQUIRED `code`, so relaying it without `code:` is a bug) from a
 * local result type that legitimately has no code (e.g. resolveArtifactsDir's
 * `{ ok, error }`). So the grep can only guard the most likely recurrence — an
 * adapter result named `result`, dropped on one line. #527's own naive class
 * fix missed 4 non-`result`-named instances for exactly this reason (the
 * instance-not-class trap, one level up).
 *
 * THIS rule is the authoritative, name-agnostic enforcement the grep only
 * approximates. It is STRUCTURAL and type-driven, not name-driven:
 *
 *   For every `if (!X.ok) return <envelope|object>({ ok: false, ... })`:
 *     - Ask the type checker for X's type.
 *     - Find the constituent whose `ok` is the literal `false`.
 *     - If that arm has a `code` property (⇒ X is an AdapterResult-shaped
 *       "coded result") AND the returned object literal omits `code` (and has
 *       no spread that could carry it) ⇒ VIOLATION.
 *     - If that arm has NO `code` property (⇒ a local result type), it is a
 *       true negative — never flagged.
 *
 * Because it keys on the type, it catches the drop regardless of the variable
 * name (defRes, prResult, existing, created, …) and regardless of single- vs
 * multi-line shape (the AST is line-insensitive). Catch blocks relaying
 * `err instanceof Error` are excluded for free: they have no `if (!X.ok)`.
 *
 * gate-greps.sh #3 is retained as a cheap first-pass (it runs with no program
 * build); THIS rule is authoritative for the class.
 *
 * Usage:
 *   bun run scripts/ci/check-adapter-error-code.ts            # scans handlers/*.ts
 *   bun run scripts/ci/check-adapter-error-code.ts a.ts b.ts  # scans given files
 */

import ts from 'typescript';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');

export interface Violation {
  file: string;
  line: number; // 1-indexed
  column: number; // 1-indexed
  varName: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Program construction (uses the project's tsconfig so cross-file types like
// AdapterResult resolve correctly).
// ---------------------------------------------------------------------------

function createProgram(): ts.Program {
  const configPath = resolve(REPO_ROOT, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      `failed to read tsconfig.json: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, REPO_ROOT);
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function unwrapParens(node: ts.Expression): ts.Expression {
  let n = node;
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  return n;
}

/** For a condition `!X.ok` (optionally parenthesized), return the `X` node. */
function extractNegatedOkOperand(cond: ts.Expression): ts.Expression | undefined {
  const c = unwrapParens(cond);
  if (!ts.isPrefixUnaryExpression(c) || c.operator !== ts.SyntaxKind.ExclamationToken) {
    return undefined;
  }
  const operand = unwrapParens(c.operand);
  if (ts.isPropertyAccessExpression(operand) && operand.name.text === 'ok') {
    return operand.expression;
  }
  return undefined;
}

/** Top-level return statements reachable from an `if` then-branch. */
function collectReturns(stmt: ts.Statement): ts.ReturnStatement[] {
  if (ts.isReturnStatement(stmt)) return [stmt];
  if (ts.isBlock(stmt)) return stmt.statements.filter(ts.isReturnStatement);
  return [];
}

/** The object literal a return builds — directly, or as the first arg of a call (envelope(...)). */
function returnedObjectLiteral(ret: ts.ReturnStatement): ts.ObjectLiteralExpression | undefined {
  const expr = ret.expression;
  if (!expr) return undefined;
  if (ts.isObjectLiteralExpression(expr)) return expr;
  if (ts.isCallExpression(expr) && expr.arguments.length > 0) {
    const first = expr.arguments[0];
    if (first && ts.isObjectLiteralExpression(first)) return first;
  }
  return undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function objectHasOkFalse(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some(
    (p) =>
      ts.isPropertyAssignment(p) &&
      propertyName(p.name) === 'ok' &&
      p.initializer.kind === ts.SyntaxKind.FalseKeyword,
  );
}

function objectHasCode(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some((p) => {
    if (ts.isPropertyAssignment(p)) return propertyName(p.name) === 'code';
    if (ts.isShorthandPropertyAssignment(p)) return p.name.text === 'code';
    return false;
  });
}

function objectHasSpread(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some((p) => ts.isSpreadAssignment(p));
}

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

/**
 * Classify X (the operand of `!X.ok`) by its type:
 *   true  → has an `ok:false` arm that carries a `code` property (coded result;
 *           an AdapterResult-shaped value)
 *   false → has an `ok:false` arm WITHOUT a `code` property (a local result type)
 *   null  → no `ok:false` arm at all (not a discriminated result — ignore)
 */
function okFalseArmHasCode(checker: ts.TypeChecker, xNode: ts.Expression): boolean | null {
  const type = checker.getTypeAtLocation(xNode);
  const constituents = type.isUnion() ? type.types : [type];
  let sawOkFalse = false;
  let hasCode = false;
  for (const c of constituents) {
    const okSym = c.getProperty('ok');
    if (!okSym) continue;
    const okType = checker.getTypeOfSymbolAtLocation(okSym, xNode);
    const isFalseLiteral =
      (okType.flags & ts.TypeFlags.BooleanLiteral) !== 0 && checker.typeToString(okType) === 'false';
    if (!isFalseLiteral) continue;
    sawOkFalse = true;
    if (c.getProperty('code')) hasCode = true;
  }
  if (!sawOkFalse) return null;
  return hasCode;
}

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

export function checkFiles(targetPaths: string[], program?: ts.Program): Violation[] {
  const prog = program ?? createProgram();
  const checker = prog.getTypeChecker();
  const wanted = new Set(targetPaths.map((p) => resolve(p)));
  const violations: Violation[] = [];

  for (const sourceFile of prog.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!wanted.has(resolve(sourceFile.fileName))) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isIfStatement(node)) {
        const x = extractNegatedOkOperand(node.expression);
        if (x) {
          const classification = okFalseArmHasCode(checker, x);
          if (classification === true) {
            // Coded result — every ok:false relay must carry `code`.
            for (const ret of collectReturns(node.thenStatement)) {
              const obj = returnedObjectLiteral(ret);
              if (
                obj &&
                objectHasOkFalse(obj) &&
                !objectHasCode(obj) &&
                !objectHasSpread(obj)
              ) {
                const { line, character } = sourceFile.getLineAndCharacterOfPosition(
                  obj.getStart(sourceFile),
                );
                violations.push({
                  file: sourceFile.fileName,
                  line: line + 1,
                  column: character + 1,
                  varName: x.getText(sourceFile),
                  message: `ok:false envelope built from AdapterResult '${x.getText(sourceFile)}' omits 'code:' — relay it as { ok: false, code: ${x.getText(sourceFile)}.code, error: ... }`,
                });
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return violations;
}

/** Default scan target: handlers/*.ts, minus tests and the generated registry. */
function defaultHandlerTargets(program: ts.Program): string[] {
  const handlersDir = resolve(REPO_ROOT, 'handlers');
  return program
    .getSourceFiles()
    .map((sf) => resolve(sf.fileName))
    .filter(
      (p) =>
        p.startsWith(handlersDir + '/') &&
        p.endsWith('.ts') &&
        !p.endsWith('.test.ts') &&
        !p.endsWith('/_registry.ts'),
    );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  const program = createProgram();
  const targets = argv.length > 0 ? argv.map((p) => resolve(p)) : defaultHandlerTargets(program);

  const violations = checkFiles(targets, program);

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.file}:${v.line}:${v.column}: ${v.message}`);
    }
    console.error('');
    console.error(
      `GATE FAIL [#534]: ${violations.length} handler(s) drop the adapter error 'code' on an ok:false envelope.`,
    );
    console.error(
      "  A relayed AdapterResult failure must preserve its typed code so MCP callers can branch on the failure type.",
    );
    process.exit(1);
  }

  console.log(`adapter-error-code: OK (${targets.length} file(s) checked, type-aware)`);
}

if (import.meta.main) {
  main();
}
