import promptsData from '../data/prompts.json';
import catalog from '../data/catalog.json';
import reference from '../data/dsl-reference.txt?raw';
import capabilities from '../data/capabilities.txt?raw';
import { compileFiles, fingerprint, WorkspaceStore } from '../storage/workspaces';
import { Diagnostic, hash, type Json } from '../compiler/compiler';
import type { ModelClient, Message } from '../llm/client';
import { parseBrief, unwrap, validatePlan } from './contracts';
const prompts = promptsData as unknown as Json;
export type WorkflowEvent = { kind: string; [key: string]: any };
export function renderPrompt(stage: string, values: Record<string, string>): Message[] {
  const spec = prompts.manifest.stages[stage]; if (!spec) throw Error('未知工作流阶段');
  return (['system', 'user'] as const).map(role => ({ role, content: (prompts[spec[role]] as string).replace(/\{\{(\w+)\}\}/g, (_, key) => { if (!(key in values)) throw Error('缺少模板变量 ' + key); return values[key]; }) }));
}
export class WorkflowRunner {
  constructor(private store: WorkspaceStore, private client: ModelClient, private emit: (id: string, event: WorkflowEvent) => void = () => {}) {}
  private async status(id: string, status: string, error?: string) { await this.store.update(id, null, w => { w.status = status; const card = [...w.chat].reverse().find(c => c.role === 'workflow'); if (card) card.status = status; }); this.emit(id, { kind: 'run_status', status, error }); }
  private async chat(id: string, item: Json) { await this.store.update(id, null, w => { w.chat.push({ id: crypto.randomUUID(), time: Date.now() / 1000, ...item }); }); this.emit(id, { kind: 'chat_updated' }); }
  private async call(id: string, label: string, messages: Message[], signal: AbortSignal) {
    signal.throwIfAborted(); const prefix = label.includes('理解') || label.includes('规划') ? 'understand' : label.includes('修正') ? 'repair' : 'generate'; const stage = prefix + '-' + crypto.randomUUID(); let output = ''; const started = Date.now();
    await this.store.update(id, null, w => { w.stages.push({ id: stage, label, input: messages, output: '', status: 'running' }); }); this.emit(id, { kind: 'stage_started', stage, label });
    try {
      const result = await this.client.complete(messages, text => { output += text; this.emit(id, { kind: 'delta', stage, text }); }, signal);
      await this.store.update(id, null, w => { Object.assign(w.stages.find(s => s.id === stage)!, { output, status: 'completed', duration_ms: Date.now() - started }); w.traces.push({ id: stage, timestamp: Date.now() / 1000, label, messages, response: output, usage: result.usage, prompt_hash: hash(JSON.stringify(messages)) }); });
      this.emit(id, { kind: 'stage_finished', stage, output }); return output;
    } catch (e) {
      await this.store.update(id, null, w => { Object.assign(w.stages.find(s => s.id === stage)!, { output, status: signal.aborted ? 'cancelled' : 'failed' }); }); this.emit(id, { kind: 'stage_finished', stage, output, status: signal.aborted ? 'cancelled' : 'failed' }); throw e;
    }
  }
  async run(id: string, message: string, signal: AbortSignal, answer = false) {
    await this.status(id, 'running');
    await this.chat(id, { role: 'user', type: 'user', text: message });
    await this.chat(id, { role: 'workflow', status: 'running', workflow_type: (await this.store.get(id)).kind, title: '故事生成与校验' });
    try {
      let w = await this.store.get(id);
      if (Object.keys(w.saved).length) await this.edit(id, message, signal);
      else if (w.kind === 'main') await this.main(id, w.story || message, signal);
      else await this.side(id, w.story || message, signal, answer ? message : '');
    } catch (e) {
      await this.status(id, signal.aborted ? 'cancelled' : 'failed', e instanceof Error ? e.message : '运行失败');
      if (!signal.aborted) await this.chat(id, { role: 'assistant', type: 'assistant', text: e instanceof Error ? e.message : '运行失败' });
    }
  }
  private values(story: string, answers: string) {
    return { story, story_with_lines: story.split(/\r?\n/).map((l, i) => `${i + 1}: ${l}`).join('\n'), user_answers: answers || '尚无补充', capabilities, resource_catalog: JSON.stringify(catalog), brief_contract: prompts['brief-contract.txt'], dsl_reference: reference, target_context: JSON.stringify({ dsl: '0.3-draft', target: 'playground-quests-v3', locale: 'zh-CN' }) };
  }
  private async compileWithRepair(id: string, initial: string, path: string, values: Record<string, string>, signal: AbortSignal) {
    let source = unwrap(initial); const seen = new Set<string>();
    for (let attempt = 0; attempt <= 2; attempt++) {
      signal.throwIfAborted(); const stage = `compile-${crypto.randomUUID()}`; await this.store.update(id, null, w => { w.stages.push({ id: stage, label: '编译校验', output: '', status: 'running' }); }); this.emit(id, { kind: 'stage_started', stage, label: '编译校验' });
      try { compileFiles({ [path]: source }); await this.store.update(id, null, w => { Object.assign(w.stages.find(s => s.id === stage)!, { status: 'completed', output: '编译和运行配置校验通过' }); }); this.emit(id, { kind: 'stage_finished', stage, output: '编译和运行配置校验通过' }); return source; }
      catch (e) {
        const diagnostics = e instanceof Diagnostic ? e.toJSON() : { message: String(e) };
        await this.store.update(id, null, w => { Object.assign(w.stages.find(s => s.id === stage)!, { status: 'failed', output: JSON.stringify(diagnostics) }); }); this.emit(id, { kind: 'stage_finished', stage, status: 'failed', output: JSON.stringify(diagnostics) });
        if (attempt === 2 || seen.has(source)) throw Error('编译修正未收敛：' + (e instanceof Error ? e.message : String(e)));
        seen.add(source); source = unwrap(await this.call(id, `修正 DSL · ${attempt + 1}`, renderPrompt('repair', { ...values, current_dsl: source, diagnostics: JSON.stringify([diagnostics]) }), signal));
      }
    }
    throw Error('编译未完成');
  }
  private async side(id: string, story: string, signal: AbortSignal, answer: string) {
    if (!story.trim() || story.length > 30000) throw Error('请输入 1–30000 字的故事');
    const existing = await this.store.get(id), values = this.values(story, answer); let brief = existing.brief;
    if (!answer || !brief) {
      brief = parseBrief(await this.call(id, '理解故事', renderPrompt('understand', values), signal), catalog, story.split(/\r?\n/).length);
      await this.store.update(id, null, w => { w.brief = brief; w.story = story; if (/^(新建|自定义|新故事)/.test(w.title)) w.title = brief!.title; }); this.emit(id, { kind: 'story_metadata', title: (await this.store.get(id)).title, summary: brief.summary });
      if (brief.questions.length) { await this.chat(id, { type: 'clarification', role: 'clarification', questions: brief.questions.map((q: Json, i: number) => ({ ...q, id: 'q_' + (i + 1), options: [] })) }); await this.status(id, 'awaiting_input'); return; }
    }
    await this.store.update(id, null, w => { w.answers = answer; w.chat.filter(c => c.type === 'clarification').forEach(c => { c.resolved = true; c.selected_summary = answer; }); });
    const genValues = { ...values, confirmed_brief: JSON.stringify({ ...brief, author_answers: answer, author_confirmed: !!answer }) };
    const source = await this.compileWithRepair(id, await this.call(id, '生成 DSL', renderPrompt('generate', genValues), signal), 'story.dsl', genValues, signal);
    signal.throwIfAborted(); await this.store.publishInitial(id, { 'story.dsl': source }, (await this.store.get(id)).title); this.emit(id, { kind: 'workspace_updated' });
    await this.chat(id, { type: 'assistant', role: 'assistant', text: '故事已生成并通过编译，可以查看节点图、编辑 DSL 或启动试玩。' }); await this.status(id, 'compiled');
  }
  private async main(id: string, story: string, signal: AbortSignal) {
    const values = this.values(story, ''), plan = validatePlan(await this.call(id, '规划章节', renderPrompt('main_plan', values), signal)), files: Record<string, string> = {};
    for (const chapter of plan.chapters) {
      const cv = { ...values, plan: JSON.stringify(plan), chapter: JSON.stringify(chapter), confirmed_brief: JSON.stringify(chapter) };
      files[chapter.file] = await this.compileWithRepair(id, await this.call(id, '生成章节 · ' + chapter.title, renderPrompt('main_chapter', cv), signal), chapter.file, cv, signal);
    }
    signal.throwIfAborted(); await this.store.publishInitial(id, files, plan.title, plan); this.emit(id, { kind: 'workspace_updated' }); await this.chat(id, { type: 'assistant', role: 'assistant', text: `已生成《${plan.title}》的 ${plan.chapters.length} 个章节，可进入章节编辑和试玩。` }); await this.status(id, 'compiled');
  }
  private async edit(id: string, message: string, signal: AbortSignal) {
    const w = await this.store.get(id); if (w.proposal) throw Error('请先接受或放弃当前修改提案');
    if (fingerprint(w.files) !== fingerprint(w.saved)) throw Error('请先保存或放弃手动修改，再让助手调整');
    const base = fingerprint(w.saved);
    const messages: Message[] = [
      { role: 'system', content: '你是游戏叙事工作台的剧情助手。根据作者请求回答当前故事的问题，或提出 DSL 修改。输出 JSON：{"reply":"给作者的简洁说明","edits":[{"path":"现有 DSL 路径","old":"原文中唯一匹配的片段","new":"替换内容"}]}。提问时 edits 为空；修改时保留其余剧情。作者确认后才会保存修改。\n语法：\n' + reference + '\n能力：\n' + capabilities },
      { role: 'user', content: JSON.stringify({ files: w.saved, memories: w.memory, recent_chat: w.chat.slice(-6).map(c => ({ role: c.role, text: c.text })), request: message }) }
    ];
    const result = JSON.parse(unwrap(await this.call(id, '理解与调整故事', messages, signal)));
    if (typeof result.reply !== 'string' || !Array.isArray(result.edits) || result.edits.length > 30) throw Error('助手输出格式不正确');
    if (!result.edits.length) { await this.chat(id, { type: 'assistant', role: 'assistant', text: result.reply }); await this.status(id, 'compiled'); return; }
    const files = { ...w.saved };
    for (const e of result.edits) {
      if (!Object.hasOwn(files, e.path) || typeof e.old !== 'string' || !e.old || typeof e.new !== 'string') throw Error('修改提案包含无效文件或片段');
      const start = files[e.path].indexOf(e.old); if (start < 0 || files[e.path].indexOf(e.old, start + e.old.length) >= 0) throw Error('修改片段未唯一匹配，请重新请求调整');
      files[e.path] = files[e.path].slice(0, start) + e.new + files[e.path].slice(start + e.old.length);
    }
    for (const path of Object.keys(files)) if (files[path] !== w.saved[path]) files[path] = await this.compileWithRepair(id, files[path], path, { ...this.values(w.story, w.answers), confirmed_brief: JSON.stringify({ request: message, original: w.brief }) }, signal);
    signal.throwIfAborted(); await this.store.stage(id, base, files, result.reply); this.emit(id, { kind: 'proposal_ready' }); await this.chat(id, { type: 'assistant', role: 'assistant', text: result.reply, proposal_id: (await this.store.get(id)).proposal!.id }); await this.status(id, 'compiled');
  }
}
