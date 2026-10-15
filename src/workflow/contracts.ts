import type { Json } from '../compiler/compiler';
export const unwrap = (text: string) => text.trim().replace(/^```[^\n]*\n([\s\S]*?)\n?```$/, '$1').trim();
export function parseBrief(text: string, catalog: Json, lineCount: number): Json {
  const b = JSON.parse(unwrap(text));
  const shapes: Record<string, Record<string, string>> = {
    actors: { id: 'string', name: 'string', role: 'string', source_lines: 'array' }, events: { id: 'string', description: 'string', actor_ids: 'array', source_lines: 'array' },
    prerequisites: { event_id: 'string', requires_event_ids: 'array', condition: 'nullable', source_lines: 'array' }, quoted_lines: { speaker_id: 'nullable', text: 'string', source_lines: 'array' },
    ending: { description: 'string', source_lines: 'array' }, resource_bindings: { subject: 'string', resource_id: 'nullable' }, assumptions: { description: 'string', source_lines: 'array' }, questions: { question: 'string', related_ids: 'array', source_lines: 'array' }
  };
  const assert = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
  assert(b && typeof b === 'object' && !Array.isArray(b), '理解输出不是对象');
  for (const [k, max] of [['title', 40], ['summary', 200]] as const) assert(typeof b[k] === 'string' && b[k].trim() && [...b[k]].length <= max, k + ' 需要简洁的非空文本');
  assert(Object.keys(b).filter(k => !['title', 'summary'].includes(k)).sort().join() === Object.keys(shapes).sort().join(), '理解输出需要契约中的八个集合字段');
  for (const [key, shape] of Object.entries(shapes)) {
    assert(Array.isArray(b[key]), key + ' 需要数组');
    for (const [index, item] of b[key].entries()) {
      assert(item && Object.keys(item).sort().join() === Object.keys(shape).sort().join(), key + ' 条目字段不符');
      for (const [field, type] of Object.entries(shape)) assert(type === 'array' ? Array.isArray(item[field]) : type === 'nullable' ? item[field] === null || typeof item[field] === 'string' : typeof item[field] === type, key + '.' + field + ' 类型不符');
      if (item.source_lines) assert(item.source_lines.every((n: any) => Number.isInteger(n) && n >= 1 && n <= lineCount), `${key}[${index}].source_lines 超出原文行号：有效范围 1–${lineCount}，实际 ${JSON.stringify(item.source_lines)}`);
    }
  }
  const actors = b.actors.map((x: Json) => x.id), events = b.events.map((x: Json) => x.id), resources = catalog.resources.map((x: Json) => x.id);
  assert(new Set(actors).size === actors.length && new Set(events).size === events.length, '局部 ID 重复');
  b.events.forEach((e: Json) => assert(e.actor_ids.every((x: any) => actors.includes(x)), '未知角色'));
  b.prerequisites.forEach((e: Json) => assert(events.includes(e.event_id) && e.requires_event_ids.every((x: any) => events.includes(x)), '未知事件'));
  b.quoted_lines.forEach((e: Json) => assert(e.speaker_id === null || actors.includes(e.speaker_id), '台词引用未知说话人'));
  b.questions.forEach((e: Json) => assert(e.related_ids.every((x: any) => actors.includes(x) || events.includes(x)), '问题引用未知 ID'));
  b.resource_bindings.forEach((e: Json) => assert(e.resource_id === null || resources.includes(e.resource_id), '资源 ID 不在目录中')); return b;
}
export function validatePlan(text: string): Json {
  const p = JSON.parse(unwrap(text));
  if (!p || typeof p.title !== 'string' || !p.title.trim() || typeof p.summary !== 'string' || !p.summary.trim() || !Array.isArray(p.chapters) || !p.chapters.length || p.chapters.length > 8) throw Error('章节规划需要标题、摘要和 1–8 章');
  const ids = new Set<string>();
  for (const c of p.chapters) { if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(c.id) || ids.has(c.id) || typeof c.title !== 'string' || !c.title.trim() || typeof c.summary !== 'string' || !c.summary.trim() || !Array.isArray(c.next)) throw Error('章节字段或 ID 不合法'); ids.add(c.id); c.file = `chapters/${c.id}.dsl`; c.status = 'compiled_chapter_only'; }
  const edges = new Map<string, Json[]>(p.chapters.map((c: Json) => [c.id, c.next]));
  for (const links of edges.values()) for (const e of links) if (!e || !ids.has(e.target) || typeof e.label !== 'string') throw Error('章节连接引用不存在或缺少条件说明');
  const visiting = new Set<string>(), done = new Set<string>();
  function visit(id: string) { if (visiting.has(id)) throw Error('章节拓扑存在循环'); if (done.has(id)) return; visiting.add(id); edges.get(id)!.forEach(e => visit(e.target)); visiting.delete(id); done.add(id); }
  visit(p.chapters[0].id); if (done.size !== ids.size) throw Error('存在无法从首章到达的章节'); p.runtime_status = 'chapter_only'; p.shared_vars = []; return p;
}
