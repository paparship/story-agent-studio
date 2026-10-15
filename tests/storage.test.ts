import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import cases from './fixtures/compiler-oracle.json';
import { WorkspaceStore, fingerprint } from '../src/storage/workspaces';
const source = cases.find(c => c.package?.schemaVersion === '0.4.0')!.source;
async function setup() { const name = crypto.randomUUID(), store = new WorkspaceStore(name), w = await store.create('side'); await store.publishInitial(w.id, { 'story.dsl': source }, '测试故事'); return { name, store, id: w.id }; }
it('persists across reopening; failed compile cannot overwrite saved source', async () => {
  const { name, store, id } = await setup(); await store.sync(id, 'story.dsl', source + '\nunsupported'); await expect(store.save(id)).rejects.toThrow(); await store.close();
  const reopened = new WorkspaceStore(name), w = await reopened.get(id); expect(w.saved['story.dsl']).toBe(source); expect(w.files['story.dsl']).toContain('unsupported'); expect(w.versions).toHaveLength(1); await reopened.close();
});
it('proposal is separate, detects dirty conflicts, rejects and restores as new version', async () => {
  const { store, id } = await setup(), w = await store.get(id); const changed = source + '\n# 修改说明';
  await store.stage(id, fingerprint(w.saved), { 'story.dsl': changed }, '调整说明'); expect((await store.get(id)).saved['story.dsl']).toBe(source);
  await store.sync(id, 'story.dsl', source + '\n# 手工修改'); await expect(store.accept(id)).rejects.toThrow('冲突'); await store.discard(id, 'story.dsl'); await store.accept(id);
  expect((await store.get(id)).versions).toHaveLength(2); await store.restore(id, 1); const restored = await store.get(id); expect(restored.versions).toHaveLength(3); expect(restored.saved['story.dsl']).toBe(source); await store.close();
});
it('concurrent writes use revision checks', async () => {
  const { store, id } = await setup(), w = await store.get(id);
  const results = await Promise.allSettled([store.update(id, w.revision, x => { x.title = '甲'; }), store.update(id, w.revision, x => { x.title = '乙'; })]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); await store.close();
});
