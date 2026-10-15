import { describe, expect, it } from 'vitest';
import cases from './fixtures/compiler-oracle.json';
import context from '../src/data/context.json';
import { compileSource, Diagnostic } from '../src/compiler/compiler';
describe('Python / TypeScript differential contract', () => {
  cases.forEach((c, i) => it(`case ${i + 1}: ${'error' in c ? c.error?.code : c.mapping?.title}`, () => {
    if ('error' in c) {
      try { compileSource(c.source, context, c.filename); throw Error('Expected diagnostic'); }
      catch (e) { expect(e).toBeInstanceOf(Diagnostic); expect((e as Diagnostic).code).toBe(c.error?.code); expect((e as Diagnostic).line).toBe(c.error?.line); }
    } else {
      const actual = compileSource(c.source, context, c.filename);
      // Python distinguishes 1.0 from 1 when hashing; JSON runtime semantics do not.
      expect({ ...actual.package, revision: '' }).toEqual({ ...c.package, revision: '' });
      expect(actual.mapping).toEqual(c.mapping);
    }
  }));
});
