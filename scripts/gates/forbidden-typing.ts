import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

export type ForbiddenTypingKind = 'them-any' | 'ts-comment' | 'double-cast';

export interface ForbiddenTypingViolation {
  readonly file: string;
  readonly line: number;
  readonly kind: ForbiddenTypingKind;
}

const BANNED_TS_COMMENT = /@ts-(ignore|expect-error|nocheck)/;

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'generated', '.git']);

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
        walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(entryPath);
      }
    }
  };
  walk(dir);
  return files;
}

function lineOf(source: ts.SourceFileLike, file: string, position: number): number {
  const { line } = source.getLineAndCharacterOfPosition(position);
  return line + 1;
}

function scanSource(file: string, root: string): ForbiddenTypingViolation[] {
  const violations: ForbiddenTypingViolation[] = [];
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const relativeName = relative(root, file);

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      violations.push({
        file: relativeName,
        line: lineOf(source, file, node.getStart(source)),
        kind: 'them-any',
      });
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(source);

  const lines = text.split('\n');
  lines.forEach((lineText, index) => {
    if (BANNED_TS_COMMENT.test(lineText)) {
      violations.push({ file: relativeName, line: index + 1, kind: 'ts-comment' });
    }
    if (/as\s+unknown\s+as/.test(lineText)) {
      violations.push({ file: relativeName, line: index + 1, kind: 'double-cast' });
    }
  });

  return violations;
}

export function scanForForbiddenTyping(roots: readonly string[]): ForbiddenTypingViolation[] {
  const violations: ForbiddenTypingViolation[] = [];
  for (const root of roots) {
    for (const file of collectTsFiles(root)) {
      violations.push(...scanSource(file, root));
    }
  }
  return violations;
}

export function runForbiddenTypingGate(roots: readonly string[]): number {
  const violations = scanForForbiddenTyping(roots);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`✗ ${violation.file}:${violation.line} forbidden typing (${violation.kind})`);
    }
    console.error(`✖ Forbidden typing gate failed: ${violations.length} violation(s)`);
    return 1;
  }
  console.log('✔ Forbidden typing gate passed: zero violations');
  return 0;
}

const mainRun = process.argv[1]?.endsWith('forbidden-typing.ts') === true;
if (mainRun) {
  const roots = process.argv.length > 2 ? process.argv.slice(2) : ['src', 'tests', 'scripts'];
  process.exitCode = runForbiddenTypingGate(roots);
}
