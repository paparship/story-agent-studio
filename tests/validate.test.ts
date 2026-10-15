import { expect, it } from 'vitest';
import cases from './fixtures/validation-oracle.json';
import compilerCases from './fixtures/compiler-oracle.json';
import { validatePackage } from '../src/compiler/validate';
for (const c of cases) it(`runtime validator: ${c.name}`, () => {
  if (c.valid) expect(() => validatePackage(c.package)).not.toThrow();
  else expect(() => validatePackage(c.package)).toThrow();
});
for (const [i, c] of compilerCases.entries()) if (c.package) it(`compiled package semantic validation ${i}`, () => expect(() => validatePackage(c.package!)).not.toThrow());
