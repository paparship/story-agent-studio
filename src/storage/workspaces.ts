import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { compileSource, hash, type Json } from '../compiler/compiler';
import { validatePackage } from '../compiler/validate';
import context from '../data/context.json';
export interface Compiled { package: Json; mapping: Json }
export interface Version { version: number; label: string; time: number; files: Record<string, string>; compiled: Record<string, Compiled> }
export interface Proposal { id: string; base: string; files: Record<string, string>; compiled: Record<string, Compiled>; summary: string }
export interface Workspace {
  id: string; title: string; kind: 'side' | 'main'; revision: number; updated: number;
  files: Record<string, string>; saved: Record<string, string>; compiled: Record<string, Compiled>;
  versions: Version[]; proposal: Proposal | null; activeChapter: string | null;
  chapters: Json | null; chat: Json[]; stages: Json[]; memory: Json[];
  status: string; story: string; brief: Json | null; answers: string; traces: Json[];
}
interface Schema extends DBSchema { workspaces: { key: string; value: Workspace }; }
export const fingerprint = (files: Record<string, string>) => hash(JSON.stringify(Object.keys(files).sort().map(k => [k, files[k]])));
export function compileFiles(files: Record<string, string>): Record<string, Compiled> {
  const output: Record<string, Compiled> = {};
  for (const [path, source] of Object.entries(files)) {
    if (!(path === 'story.dsl' || /^chapters\/[A-Za-z][A-Za-z0-9_]{0,39}\.dsl$/.test(path))) throw Error('仅可编辑故事 DSL 文件');
    if (source.length > 200000) throw Error('DSL 文件过大');
    const result = compileSource(source, context, path); validatePackage(result.package); output[path] = result;
  }
  return output;
}
export class WorkspaceStore {
  private db: Promise<IDBPDatabase<Schema>>;
  constructor(name = 'story-agent-studio-v1') { this.db = openDB<Schema>(name, 1, { upgrade(db) { db.createObjectStore('workspaces', { keyPath: 'id' }); } }); }
  async list() { return (await (await this.db).getAll('workspaces')).sort((a, b) => b.updated - a.updated); }
  async get(id: string) { const w = await (await this.db).get('workspaces', id); if (!w) throw Error('故事不存在'); return w; }
  async create(kind: 'side' | 'main', story = '', title = '新建故事') {
    const w: Workspace = { id: crypto.randomUUID(), title, kind, revision: 0, updated: Date.now(), files: {}, saved: {}, compiled: {}, versions: [], proposal: null, activeChapter: null, chapters: null, chat: [], stages: [], memory: [], status: 'queued', story, brief: null, answers: '', traces: [] };
    await (await this.db).add('workspaces', w); return w;
  }
  /** Synchronous mutation inside an IDB transaction; concurrent tabs cannot overwrite a newer revision. */
  async update(id: string, expected: number | null, mutate: (w: Workspace) => void): Promise<Workspace> {
    const tx = (await this.db).transaction('workspaces', 'readwrite'), w = await tx.store.get(id);
    if (!w || expected !== null && w.revision !== expected) { await tx.done; throw Error('故事已在其他窗口更新，请刷新后重试'); }
    mutate(w); w.revision++; w.updated = Date.now(); await tx.store.put(w); await tx.done; return w;
  }
  async sync(id: string, path: string, source: string) {
    if (source.length > 200000) throw Error('DSL 文件过大');
    return this.update(id, null, w => { if (!Object.hasOwn(w.saved, path)) throw Error('未知 DSL 文件'); w.files[path] = source; });
  }
  private commit(w: Workspace, files: Record<string, string>, compiled: Record<string, Compiled>, label: string) {
    if (!Object.keys(files).length) throw Error('没有可保存的 DSL');
    const version = w.versions.length + 1;
    w.files = structuredClone(files); w.saved = structuredClone(files); w.compiled = structuredClone(compiled); w.proposal = null; w.status = 'compiled';
    w.versions.push({ version, label: label.trim() || `版本 ${version}`, time: Date.now(), files: structuredClone(files), compiled: structuredClone(compiled) });
  }
  async save(id: string, label = '手动修改') {
    const before = await this.get(id); if (before.proposal) throw Error('请先处理待确认修改'); const compiled = compileFiles(before.files);
    return this.update(id, before.revision, w => this.commit(w, before.files, compiled, label));
  }
  async publishInitial(id: string, files: Record<string, string>, title: string, chapters: Json | null = null) {
    const before = await this.get(id); if (Object.keys(before.saved).length) throw Error('已有故事需通过修改提案保存'); const compiled = compileFiles(files);
    return this.update(id, before.revision, w => { this.commit(w, files, compiled, '初始生成'); w.title = title; w.chapters = chapters; });
  }
  async stage(id: string, base: string, files: Record<string, string>, summary: string) {
    const before = await this.get(id); if (before.proposal) throw Error('已有待确认修改');
    if (fingerprint(before.files) !== base || fingerprint(before.saved) !== base) throw Error('源码已发生变化，请先保存或放弃手动修改');
    for (const path of Object.keys(files)) if (!Object.hasOwn(before.saved, path)) throw Error('提案引用了未知文件');
    const proposed = { ...before.saved, ...files }, compiled = compileFiles(proposed);
    return this.update(id, before.revision, w => { w.proposal = { id: crypto.randomUUID(), base, files: proposed, compiled, summary }; });
  }
  async accept(id: string) {
    const before = await this.get(id), p = before.proposal; if (!p) throw Error('没有待确认修改');
    if (fingerprint(before.files) !== p.base || fingerprint(before.saved) !== p.base) throw Error('提案与当前源码冲突，请放弃提案后重新生成');
    const compiled = compileFiles(p.files); return this.update(id, before.revision, w => this.commit(w, p.files, compiled, p.summary));
  }
  async reject(id: string) { return this.update(id, null, w => { w.proposal = null; }); }
  async discard(id: string, path: string) { return this.update(id, null, w => { if (!Object.hasOwn(w.saved, path)) throw Error('未知文件'); w.files[path] = w.saved[path]; }); }
  async restore(id: string, version: number) {
    const before = await this.get(id); if (before.proposal || fingerprint(before.files) !== fingerprint(before.saved)) throw Error('请先处理未保存修改和提案');
    const old = before.versions.find(v => v.version === version); if (!old) throw Error('版本不存在'); const compiled = compileFiles(old.files);
    return this.update(id, before.revision, w => this.commit(w, old.files, compiled, `恢复版本 ${version}`));
  }
  async close() { (await this.db).close(); }
}
