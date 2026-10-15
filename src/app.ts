import { WorkspaceStore, type Workspace, fingerprint } from './storage/workspaces';
import { OpenAIClient, type ModelClient, type Provider } from './llm/client';
import { WorkflowRunner, type WorkflowEvent } from './workflow/runner';
import examples from './data/examples.json';
import type { Json } from './compiler/compiler';
export const store = new WorkspaceStore();
const controllers = new Map<string, AbortController>(), listeners = new Map<string, Set<(e: WorkflowEvent) => void>>(), events = new Map<string, WorkflowEvent[]>();
let seq = 0;
const proxy = import.meta.env.VITE_PROXY_URL || '';
function emit(id: string, event: WorkflowEvent) { const e = { ...event, seq: ++seq }; const log = events.get(id) || []; log.push(e); events.set(id, log.slice(-2000)); listeners.get(id)?.forEach(f => f(e)); }
export class LocalStream {
  onmessage?: (v: { data: string }) => void; onopen?: () => void; onerror?: () => void;
  private id: string; private closed = false; private fn: (e: WorkflowEvent) => void;
  constructor(path: string) {
    const u = new URL(path, location.origin), after = Number(u.searchParams.get('after') || 0); this.id = u.pathname.split('/')[3];
    this.fn = e => { if (!this.closed && e.seq > after) this.onmessage?.({ data: JSON.stringify(e) }); };
    queueMicrotask(() => { if (this.closed) return; this.onopen?.(); (events.get(this.id) || []).forEach(this.fn); if (!listeners.has(this.id)) listeners.set(this.id, new Set()); listeners.get(this.id)!.add(this.fn); });
  }
  close() { this.closed = true; listeners.get(this.id)?.delete(this.fn); }
}
function runSnapshot(w: Workspace) { return { id: w.id, kind: w.kind, label: w.title, story: w.story, status: w.status, stages: w.stages, version_num: w.versions.length || 1, dirty_files: Object.keys(w.files).filter(p => w.files[p] !== w.saved[p]), has_proposal: !!w.proposal, cursor: seq, updated: w.updated / 1000 }; }
function proposalView(w: Workspace) {
  if (!w.proposal) return null;
  const diffs = Object.fromEntries(Object.entries(w.proposal.files).filter(([p, s]) => s !== w.saved[p]).map(([path, source]) => {
    const old = (w.saved[path] || '').split('\n'), next = source.split('\n');
    return [path, { path, added: next.length, removed: old.length, diff_text: `--- ${path}\n+++ ${path}\n` + old.map(l => '-' + l).join('\n') + '\n' + next.map(l => '+' + l).join('\n') }];
  }));
  return { id: w.proposal.id, summary: w.proposal.summary, diffs };
}
async function payload(id: string) {
  const w = await store.get(id), proposal = proposalView(w);
  return { run: runSnapshot(w), workspace: { kind: w.kind, version_num: w.versions.length || 1, active_chapter: w.activeChapter, saved_files: w.saved, workspace_files: w.files, proposed_files: w.proposal?.files || {}, proposal_meta: proposal, versions: w.versions.map(v => ({ ...v, time: v.time / 1000 })) },
    chat: { items: w.chat.map(c => c.proposal_id && proposal?.id === c.proposal_id ? { ...c, proposal } : c) }, memory: { memories: w.memory }, chapters: w.chapters, traces: w.traces };
}
async function model(provider?: Provider): Promise<ModelClient> {
  if (provider) return OpenAIClient.custom(provider);
  if (!proxy) throw Error('默认服务尚未配置，可在设置中填写自己的 API');
  let token = localStorage.getItem('story-visitor-token');
  if (!token) { const r = await fetch(proxy + '/session', { method: 'POST' }); if (!r.ok) throw Error('无法建立体验会话'); token = (await r.json()).token; localStorage.setItem('story-visitor-token', token!); }
  const r = await fetch(proxy + '/operations', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: crypto.randomUUID() }) });
  if (!r.ok) { const error = await r.json().catch(() => ({})); if (error.code === 'QUOTA_EXHAUSTED') throw Error('体验额度已用完，请在设置中配置自己的 API 后继续使用。'); throw Error('暂时无法开始生成，请稍后重试'); }
  const op = await r.json(); return new OpenAIClient(proxy + '/chat/completions', { Authorization: 'Bearer ' + token, 'X-Operation-Id': op.id }, 'deepseek-flash');
}
async function start(id: string, message: string, provider?: Provider, answer = false) {
  if (controllers.has(id)) throw Error('当前故事正在生成');
  const c = new AbortController(); controllers.set(id, c);
  const execute = async () => {
    try { let ready: Promise<ModelClient> | undefined; const client: ModelClient = { complete: async (...args) => { ready ??= model(provider); return (await ready).complete(...args); } }; const runner = new WorkflowRunner(store, client, emit); await runner.run(id, message, c.signal, answer); }
    catch (e) { const error = e instanceof Error ? e.message : '生成失败'; await store.update(id, null, w => { w.status = 'failed'; w.chat.push({ role: 'assistant', text: error }); }); emit(id, { kind: 'run_status', status: 'failed', error }); }
    finally { controllers.delete(id); }
  };
  // Browser locks serialize generation across tabs without a backend coordinator.
  void navigator.locks.request('story-run:' + id, { ifAvailable: true }, async lock => { if (lock) await execute(); else { controllers.delete(id); emit(id, { kind: 'run_status', status: 'running', error: '故事正在另一窗口生成' }); } });
}
export async function api(path: string, body?: Json): Promise<any> {
  const url = new URL(path, location.origin), parts = url.pathname.split('/').filter(Boolean);
  if (path === '/api/health') return { key_configured: !!proxy, storage: 'browser' };
  if (path === '/api/provider/test') { const client = OpenAIClient.custom(body!.provider); await client.complete([{ role: 'user', content: '回复 OK' }], () => {}); return { model: body!.provider.model }; }
  if (url.pathname === '/api/traces') {
    const rows = await store.list(), filter = url.searchParams.get('run_id');
    return { traces: rows.filter(w => !filter || w.id === filter).flatMap(w => w.traces.map(t => ({ ...t, run_id: w.id, story_label: w.title, story_kind: w.kind }))), sessions: rows.map(w => ({ id: w.id, label: w.title, kind: w.kind, trace_count: w.traces.length })) };
  }
  if (parts.length === 2 && parts[1] === 'runs') {
    if (!body) return (await store.list()).map(runSnapshot);
    const w = await store.create(body.kind === 'main' ? 'main' : 'side', body.message || '', body.label || '新建故事'); if (body.auto_start) await start(w.id, body.message, body.provider); return { id: w.id };
  }
  const id = parts[2], action = parts.slice(3).join('/');
  if (!id) throw Error('未知操作');
  if (!body) { if (action === 'workspace') return payload(id); if (action === 'memory') return { memories: (await store.get(id)).memory }; throw Error('未知读取操作'); }
  if (action === 'chat' || action === 'answer') { const message = action === 'chat' ? body.message : body.answers; if (typeof message !== 'string' || !message.trim() || message.length > 30000) throw Error('请输入有效文本'); await start(id, message, body.provider, action === 'answer'); return { ok: true }; }
  if (action === 'cancel') { controllers.get(id)?.abort(); return { ok: true }; }
  if (controllers.has(id)) throw Error('生成完成后再操作');
  if (action === 'workspace/sync') await store.sync(id, body.path, body.content);
  else if (action === 'workspace/save') { await store.sync(id, body.path, body.content); await store.save(id); }
  else if (action === 'workspace/discard') await store.discard(id, body.path);
  else if (action === 'workspace/restore') await store.restore(id, body.version);
  else if (action === 'workspace/chapter') await store.update(id, null, w => { if (body.chapter_id !== null && !w.chapters?.chapters.some((c: Json) => c.id === body.chapter_id)) throw Error('章节不存在'); w.activeChapter = body.chapter_id; });
  else if (action === 'proposal/accept') await store.accept(id);
  else if (action === 'proposal/reject') await store.reject(id);
  else if (action === 'clear') await store.update(id, null, w => { w.chat = []; w.stages = []; });
  else if (action === 'memory') {
    await store.update(id, null, w => {
      if (body.action === 'delete') w.memory = w.memory.filter(m => m.id !== body.id && m.topic !== body.topic);
      else { if (typeof body.rule !== 'string' || !body.rule.trim()) throw Error('请输入记忆内容'); const old = w.memory.find(m => m.id === body.id || m.topic === body.topic); if (old) Object.assign(old, { topic: body.topic, rule: body.rule, scope_entities: body.scope_entities || [] }); else { if (w.memory.length >= 8) throw Error('最多保存 8 条故事记忆'); w.memory.push({ id: crypto.randomUUID(), topic: body.topic || '创作规则', rule: body.rule, scope_entities: body.scope_entities || [], trigger: 'explicit_user_rule' }); } }
    }); return { memories: (await store.get(id)).memory };
  } else throw Error('此操作尚未接入浏览器工作台');
  return payload(id);
}
export async function readText(path: string) {
  const m = /^\/artifacts\/([^/]+)\/candidate\/candidate\.(json|story)$/.exec(path); if (!m) throw Error('未知文件');
  const w = await store.get(m[1]), file = w.activeChapter ? w.chapters?.chapters.find((c: Json) => c.id === w.activeChapter)?.file : Object.keys(w.saved)[0];
  if (!file || !w.compiled[file]) throw Error('尚未编译'); return m[2] === 'json' ? JSON.stringify(w.compiled[file].package, null, 2) : w.saved[file];
}
export async function initialize() {
  if (!(await store.list()).length) for (const e of examples) { const w = await store.create('side', e.story); try { const title = /^story\s+"([^"]+)"/m.exec(e.dsl)?.[1] || e.id; await store.publishInitial(w.id, { 'story.dsl': e.dsl }, title); } catch (error) { await store.update(w.id, null, w => { w.status = 'failed'; w.chat.push({ role: 'assistant', text: String(error) }); }); } }
  for (const w of await store.list()) if (w.status === 'running') await navigator.locks.request('story-run:' + w.id, { ifAvailable: true }, async lock => { if (lock) await store.update(w.id, null, w => { w.status = 'interrupted'; }); });
}
