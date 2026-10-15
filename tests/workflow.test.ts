import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { WorkspaceStore } from '../src/storage/workspaces';
import { WorkflowRunner } from '../src/workflow/runner';
import examples from '../src/data/examples.json';
import type { ModelClient } from '../src/llm/client';
const brief = { title: '镇口口信', summary: '传递口信', actors: [], events: [], prerequisites: [], quoted_lines: [], ending: [], resource_bindings: [], assumptions: [], questions: [] };
function client(outputs: string[]): ModelClient { return { async complete(_messages, delta, signal) { signal?.throwIfAborted(); const text = outputs.shift(); if (text === undefined) throw Error('unexpected model call'); delta(text); return { text, finishReason: 'stop', usage: null }; } }; }
async function setup() { const store = new WorkspaceStore(crypto.randomUUID()), w = await store.create('side', '帮工人传话'); return { store, id: w.id }; }
it('generation persists source, compiled stages, trace and initial version', async () => {
  const { store, id } = await setup(); await new WorkflowRunner(store, client([JSON.stringify(brief), examples[0].dsl])).run(id, '帮工人传话', new AbortController().signal);
  const w = await store.get(id); expect(w.status).toBe('compiled'); expect(w.versions).toHaveLength(1); expect(w.stages.find(s => s.id.startsWith('compile-'))?.status).toBe('completed'); expect(w.traces).toHaveLength(2); await store.close();
});
it('clarification pauses without publishing, then resumes with author answers', async () => {
  const { store, id } = await setup(), model = client([JSON.stringify({ ...brief, questions: [{ question: '是否有奖励？', related_ids: [], source_lines: [1] }] }), examples[0].dsl]), runner = new WorkflowRunner(store, model);
  await runner.run(id, '帮工人传话', new AbortController().signal); expect((await store.get(id)).status).toBe('awaiting_input'); expect((await store.get(id)).versions).toHaveLength(0);
  await runner.run(id, '没有奖励', new AbortController().signal, true); expect((await store.get(id)).status).toBe('compiled'); expect((await store.get(id)).chat.find(c => c.type === 'clarification')?.resolved).toBe(true); await store.close();
});
it('invalid model output is repaired through compiler diagnostics', async () => {
  const { store, id } = await setup(); await new WorkflowRunner(store, client([JSON.stringify(brief), 'invalid syntax', examples[0].dsl])).run(id, '帮工人传话', new AbortController().signal);
  const w = await store.get(id); expect(w.status).toBe('compiled'); expect(w.stages.filter(s => s.id.startsWith('compile-')).map(s => s.status)).toEqual(['failed', 'completed']); await store.close();
});
it('failed generation never publishes a fallback story', async () => {
  const { store, id } = await setup(); await new WorkflowRunner(store, client([JSON.stringify(brief), 'invalid', 'invalid', 'invalid', 'invalid'])).run(id, '帮工人传话', new AbortController().signal);
  const w = await store.get(id); expect(w.status).toBe('failed'); expect(w.saved).toEqual({}); expect(w.versions).toHaveLength(0); await store.close();
});
it('repairs invalid source line references with exact feedback and retains failed output', async () => {
  const { store, id } = await setup();
  const invalid = JSON.stringify({ ...brief, ending: [{ description: '结束', source_lines: [2] }] });
  const inputs: any[] = [], outputs = [invalid, JSON.stringify(brief), examples[0].dsl];
  const model: ModelClient = { async complete(messages, delta) { inputs.push(messages); const text = outputs.shift()!; delta(text); return { text, finishReason: 'stop', usage: null }; } };
  await new WorkflowRunner(store, model).run(id, '一行故事。第二句话。', new AbortController().signal);
  const w = await store.get(id);
  expect(w.status).toBe('compiled'); expect(w.stages[0].status).toBe('failed'); expect(w.stages[0].output).toBe(invalid);
  expect(inputs[1].at(-1).content).toContain('ending[0].source_lines'); expect(inputs[1].at(-1).content).toContain('1–1');
  expect(w.versions).toHaveLength(1); await store.close();
});
it('stops after three structural repair attempts without publishing', async () => {
  const { store, id } = await setup();
  await new WorkflowRunner(store, client(['{}', '{}', '{}', '{}'])).run(id, '故事', new AbortController().signal);
  const w = await store.get(id); expect(w.status).toBe('failed'); expect(w.stages).toHaveLength(4); expect(w.versions).toHaveLength(0); await store.close();
});
it('editing creates a proposal; acceptance is explicit and versioned', async () => {
  const { store, id } = await setup(); await store.publishInitial(id, { 'story.dsl': examples[0].dsl }, '口信');
  const old = examples[0].dsl.split('\n')[0];
  await new WorkflowRunner(store, client([JSON.stringify({ reply: '调整标题', edits: [{ path: 'story.dsl', old, new: 'story "远方的口信"' }] })])).run(id, '标题改成远方的口信', new AbortController().signal);
  const w = await store.get(id); expect(w.proposal).not.toBeNull(); expect(w.saved['story.dsl']).toBe(examples[0].dsl); await store.accept(id); expect((await store.get(id)).versions).toHaveLength(2); await store.close();
});

it('repairs invalid edit path and nonmatching text up to third retry without user input', async () => {
  const { store, id } = await setup(); await store.publishInitial(id, { 'story.dsl': examples[0].dsl }, '口信');
  const old = examples[0].dsl.split('\n')[0];
  const edit = (path: string, value: string) => JSON.stringify({ reply: '调整标题', edits: [{ path, old: value, new: 'story "新的标题"' }] });
  const inputs: any[] = [], outputs = [edit('story.dsl > say', old), edit('story.dsl', '不存在的片段'), '{}', edit('story.dsl', old)];
  const model: ModelClient = { async complete(messages, delta) { inputs.push(messages); const text = outputs.shift()!; delta(text); return { text, finishReason: 'stop', usage: null }; } };
  await new WorkflowRunner(store, model).run(id, '换个标题', new AbortController().signal);
  const w = await store.get(id); expect(w.proposal).not.toBeNull(); expect(w.saved['story.dsl']).toBe(examples[0].dsl);
  expect(inputs).toHaveLength(4); expect(inputs[1].at(-1).content).toContain('enum'); expect(inputs[2].at(-1).content).toContain('精确且唯一匹配');
  expect(w.traces).toHaveLength(4); await store.close();
});
it('exhausted edit retries leave saved source and proposal unchanged', async () => {
 const { store, id } = await setup(); await store.publishInitial(id, { 'story.dsl': examples[0].dsl }, '口信');
 await new WorkflowRunner(store, client(['{}','{}','{}','{}'])).run(id,'修改台词',new AbortController().signal);
 const w = await store.get(id); expect(w.status).toBe('failed'); expect(w.proposal).toBeNull(); expect(w.versions).toHaveLength(1); await store.close();
});
