import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { scanForForbiddenTyping } from '../../scripts/gates/forbidden-typing.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'gate-fixture-'));
}

describe('scanForForbiddenTyping', () => {
  const asAny = ['as', 'any'].join(' ');
  const asUnknownAs = ['as', 'unknown', 'as'].join(' ');
  const tsExpect = '@ts-expect' + '-error';

  it('flags an explicit "any" type annotation', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'any-annotation.ts'),
      'export const value: any = 1;\n',
    );
    const violations = scanForForbiddenTyping([dir]);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toContain('any-annotation.ts');
    expect(violations[0].line).toBe(1);
  });

  it('flags "as any" casts, double casts and ts-ignore comments', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'escapes.ts'),
      [
        `const a = {} ${asAny};`,
        `const b = {} ${asUnknownAs} number;`,
        `// ${tsExpect}`,
        'const c = JSON.parse("[]");',
      ].join('\n'),
    );
    const violations = scanForForbiddenTyping([dir]);
    const kinds = violations.map((v) => v.kind);
    expect(kinds).toContain('them-any');
    expect(kinds).toContain('double-cast');
    expect(kinds).toContain('ts-comment');
  });

  it('flags any in generics, function params and catch bindings', () => {
    const dir = makeTmpDir();
    const sub = join(dir, 'nested');
    mkdirSync(sub);
    writeFileSync(
      join(sub, 'generics.ts'),
      [
        'function f(x: Array<any>): void {}',
        'function g(y = {} as any): void {}',
      ].join('\n'),
    );
    const violations = scanForForbiddenTyping([dir]);
    expect(violations.length).toBeGreaterThanOrEqual(2);
    expect(violations.every((v) => v.kind === 'them-any')).toBe(true);
  });

  it('does not flag the English word "any" in strings, comments or variable names', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'clean.ts'),
      [
        'const anyWord = "this string contains the word any";',
        '// and any comment may mention it',
        'export const allowed = anyWord;',
        'type Container = { value: string };',
        'export function pick(container: Container): string {',
        '  return container.value;',
        '}',
      ].join('\n'),
    );
    const violations = scanForForbiddenTyping([dir]);
    expect(violations).toEqual([]);
  });
});
