import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { fail, identifier, isCall, keys, Line, lines, number, Seconds, Tokens } from './syntax';
export { Diagnostic } from './syntax';
// JSON is validated at the package boundary. Maps hold author aliases, never JS properties.
export type Json = Record<string, any>;
export const hash = (s: string) => bytesToHex(sha256(new TextEncoder().encode(s)));
const logical = (prefix: string, name: string) => prefix + '_' + hash(name).slice(0, 12);
const stable = (v: any): string => Array.isArray(v) ? '[' + v.map(stable).join(', ') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ': ' + stable(v[k])).join(', ') + '}' : JSON.stringify(v);
export class Compiler {
  root: Line[]; package: Json; independent: boolean;
  actors = new Map<string, Json>(); regions = new Map<string, Json>(); points = new Map<string, Json>();
  quests = new Map<string, string>(); items = new Map<string, string>(); tasks = new Map<string, Map<string, string>>();
  names = new Set<string>(); maps: Json = {}; warnings: Json[] = []; graph = ''; nodes: Json[] = []; used = new Set<string>();
  constructor(source: string, context: Json, public filename = '<story>') {
    this.root = lines(source); this.package = structuredClone(context);
    this.independent = this.root.some(n => n.text === 'target "playground-quests-v3"');
    if (context.schemaVersion !== '0.2.0') fail('E_CONTEXT', 1, '本版编译器使用 0.2.0 基础上下文，避免覆盖已有空间演员');
    Object.assign(this.package, { schemaVersion: '0.3.0', capabilityProfile: 'playground-spatial-v2', stage: 'dsl', spatial: { actors: [], regions: [], points: [] } });
    if (this.independent) Object.assign(this.package, { schemaVersion: '0.4.0', capabilityProfile: 'playground-quests-v3', quests: [], graphs: [], bindings: [], texts: {} });
  }
  ref<T>(table: Map<string, T>, name: unknown, line: number, kind: string): T { if (typeof name !== 'string' || !table.has(name)) fail('E_REFERENCE', line, `未知${kind} ${String(name)}`, '可用名称：' + [...table.keys()].join(', ')); return table.get(name)!; }
  actor(name: unknown, line: number) { return this.ref(this.actors, name, line, '演员'); }
  unique(name: string, n: Line) { if (!identifier(name) || name === '玩家' || this.names.has(name)) fail('E_NAME', n.number, `重复、保留或非法名称 ${name}`); this.names.add(name); }
  vector(v: unknown, line: number) { if (!Array.isArray(v) || v.length !== 3) fail('E_VECTOR', line, 'offset 需要三个数'); return v.map(x => number(x, line, 'offset', -50, 50)); }
  seed(v: unknown, line: number) { const n = number(v, line, 'seed', 0, 1000000); if (!Number.isInteger(n)) fail('E_RANGE', line, 'seed 必须为整数'); return n; }
  quantity(v: unknown, line: number, min = 1) { const n = number(v, line, 'count', min, 999); if (!Number.isInteger(n)) fail('E_RANGE', line, '数量必须为整数'); return n; }
  block(n: Line) { if (!n.block || !n.children.length) fail('E_EMPTY_BLOCK', n.number, `${n.text} 需要非空缩进块`); }
  declareQuest(n: Line) {
    if (!this.independent) fail('E_CAPABILITY', n.number, '新建任务需要 target "playground-quests-v3"');
    this.block(n); const t = new Tokens(n.text, n.number); t.pop('quest'); const alias = t.pop(); this.unique(alias, n); const kw = t.options(); keys(kw, ['id', 'title'], n.number);
    const id = kw.id, title = kw.title;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(id)) fail('E_QUEST', n.number, '任务需要 id=小写英文标识');
    if ([...this.quests.values()].includes(id)) fail('E_QUEST', n.number, '重复任务 ID ' + id);
    if (typeof title !== 'string' || !title.trim()) fail('E_QUEST', n.number, '任务需要 title="显示名称"');
    this.quests.set(alias, id); const aliases = new Map<string, string>(); this.tasks.set(id, aliases);
    const tasks: Json[] = [], rewards: Json[] = [], pending: { task: Json; after: unknown[]; line: number }[] = [];
    const nameKey = id + '.title'; this.package.texts[nameKey] = title;
    for (const child of n.children) {
      if (child.block) fail('E_QUEST', child.number, '任务声明内不接受嵌套块');
      const t = new Tokens(child.text, child.number), kind = t.pop();
      if (kind === 'reward') { const item = this.ref(this.items, t.pop(), child.number, '物品'), opts = t.options(); keys(opts, ['count'], child.number); rewards.push({ item, quantity: this.quantity(opts.count, child.number) }); continue; }
      if (kind !== 'task') fail('E_QUEST', child.number, '任务声明只接受 task / reward');
      const name = t.pop(), opts = t.options(); keys(opts, ['title', 'after', 'final', 'collect', 'count'], child.number);
      if (!identifier(name) || aliases.has(name)) fail('E_QUEST', child.number, '重复或非法阶段名称 ' + name);
      const taskId = logical('t', id + '.' + name); aliases.set(name, taskId);
      const title = opts.title, final = opts.final ?? false, after = opts.after ?? [];
      if (typeof title !== 'string' || !title.trim() || typeof final !== 'boolean' || !Array.isArray(after)) fail('E_QUEST', child.number, '阶段需要 title，after 为列表，final 为布尔值');
      if (new Set(after).size !== after.length) fail('E_QUEST', child.number, 'after 中有重复阶段');
      const task: Json = { id: taskId, nameKey: taskId + '.title', activate: { mode: 'auto', when: { always: true } }, complete: { mode: 'manual' }, finishQuest: final };
      this.package.texts[task.nameKey] = title;
      if ('collect' in opts) { task.complete = { mode: 'auto' }; task.progress = { kind: 'collected', targetRef: this.ref(this.items, opts.collect, child.number, '物品'), required: this.quantity(opts.count, child.number), countFrom: 'taskActivation' }; }
      else if ('count' in opts) fail('E_QUEST', child.number, 'count 需要 collect');
      tasks.push(task); pending.push({ task, after, line: child.number });
    }
    if (!tasks.length || tasks.filter(t => t.finishQuest).length !== 1) fail('E_QUEST', n.number, '每个任务需要阶段，并且恰好一个 final=true 阶段');
    for (const { task, after, line } of pending) { const deps = after.map(name => this.ref(aliases, name, line, '前置阶段')); if (deps.length) task.activate.when = { all: deps.map(dep => ({ taskStatus: { quest: id, task: dep, is: 'finished' } })) }; }
    this.package.quests.push({ id, nameKey, repeatable: false, tasks, rewards: { items: rewards, experienceProfileRef: 'none' } });
  }
  declare(n: Line) {
    const t = new Tokens(n.text, n.number), kind = t.pop();
    if (kind === 'use') {
      const category = t.pop(), alias = t.pop(); t.pop('='); const resource = t.value(); t.done();
      const table = category === 'quest' ? this.quests : category === 'item' ? this.items : null;
      const allowed = category === 'quest' ? this.package.quests.map((q: Json) => q.id) : ['ruined_cheese', 'high_potion', 'revive_potion', 'magic_crystal'];
      if (!table || typeof resource !== 'string' || !allowed.includes(resource)) fail('E_RESOURCE', n.number, '未知资源类型或 ID'); this.unique(alias, n); table.set(alias, resource); return;
    }
    const alias = t.pop(); this.unique(alias, n); t.pop('='); const v = t.value(); t.done();
    if (!isCall(v)) fail('E_DECLARATION', n.number, '需要声明函数');
    const { call, args, kwargs: kw } = v, line = n.number;
    const arity = (count: number) => { if (args.length !== count) fail('E_ARGUMENT', line, `${call} 需要 ${count} 个位置参数`); };
    if (kind === 'actor') {
      arity(1); const a: Json = { id: logical('a', alias), name: alias };
      if (call === 'scene') {
        keys(kw, [], line); if (!['world.witch_town', 'world.witch_forest', 'world.witch_outpost'].includes(String(args[0]))) fail('E_CAPABILITY', line, '当前档位未注册该 scene 对象');
        if ([...this.actors.values()].some(a => a.bindingKey === args[0])) fail('E_ALIAS', line, '同一场景对象不可重复声明'); a.bindingKey = args[0];
      } else if (call === 'spawn') {
        keys(kw, ['anchor', 'offset'], line); if (!['knight', 'worker'].includes(String(args[0]))) fail('E_RESOURCE', line, '仅支持 knight / worker 预制体'); const anchor = this.actor(kw.anchor, line);
        if (!anchor.bindingKey) fail('E_ANCHOR', line, 'spawn 锚点必须为 scene 演员'); Object.assign(a, { prefabRef: args[0], spawn: { anchor: anchor.id, offset: this.vector(kw.offset, line) } });
      } else fail('E_DECLARATION', line, 'actor 需要 scene 或 spawn');
      this.actors.set(alias, a); this.package.spatial.actors.push(a);
    } else if (kind === 'region') {
      arity(0); keys(kw, ['anchor', 'radius'], line); if (call !== 'circle') fail('E_DECLARATION', line, 'region 只支持 circle');
      const r = { id: logical('r', alias), name: alias, anchor: this.actor(kw.anchor, line).id, radius: number(kw.radius, line, 'radius', .5, 30) }; this.regions.set(alias, r); this.package.spatial.regions.push(r);
    } else if (kind === 'point') {
      const p: Json = { id: logical('p', alias) };
      if (call === 'near') { arity(1); keys(kw, ['min', 'max', 'seed'], line); const min = number(kw.min, line, 'min', .5, 20), max = number(kw.max, line, 'max', .5, 30); if (max < min) fail('E_RANGE', line, 'max 不可小于 min'); Object.assign(p, { kind: 'near', actor: this.actor(args[0], line).id, minDistance: min, maxDistance: max, seed: this.seed(kw.seed, line) }); }
      else if (call === 'sample') { arity(1); keys(kw, ['seed'], line); Object.assign(p, { kind: 'area', region: this.ref(this.regions, args[0], line, '区域').id, seed: this.seed(kw.seed, line) }); }
      else if (call === 'offset') { arity(2); keys(kw, [], line); Object.assign(p, { kind: 'offset', anchor: this.actor(args[0], line).id, offset: this.vector(args[1], line) }); }
      else fail('E_DECLARATION', line, '未知 point 类型');
      this.points.set(alias, p); this.package.spatial.points.push(p);
    } else fail('E_DECLARATION', line, '未知声明 ' + kind);
  }
  questTask(t: Tokens): [string, string] {
    const q = this.ref(this.quests, t.pop(), t.line, '任务'); t.pop('.'); let task = t.pop();
    if (this.tasks.has(q)) task = this.ref(this.tasks.get(q)!, task, t.line, '阶段');
    if (!this.package.quests.some((y: Json) => y.id === q && y.tasks.some((x: Json) => x.id === task))) fail('E_REFERENCE', t.line, '未知任务阶段 ' + task); return [q, task];
  }
  condition(text: string, line: number): Json {
    const t = new Tokens(text, line);
    const atom = (): Json => {
      if (t.peek() === 'not') { t.pop(); return { not: atom() }; }
      if (t.peek() === '(') { t.pop(); const c = expr(); t.pop(')'); return c; }
      const k = t.pop(); t.pop('('); let value: Json, key: string;
      if (k === 'task') { const [quest, task] = this.questTask(t); value = { quest, task }; key = 'taskStatus'; }
      else if (k === 'quest') { value = { quest: this.ref(this.quests, t.pop(), line, '任务') }; key = 'questStatus'; }
      else if (k === 'inventory') { const item = this.ref(this.items, t.pop(), line, '物品'); t.pop(')'); t.pop('>='); return { inventory: { owner: 'player', item, gte: this.quantity(t.value(), line, 0) } }; }
      else fail('E_CONDITION', line, '未知条件 ' + k);
      t.pop(')'); t.pop('.'); const status = t.pop();
      if (![...(k === 'quest' ? ['notAdded'] : []), 'inactive', 'active', 'finished', 'failed'].includes(status)) fail('E_CONDITION', line, '未知状态 ' + status);
      value.is = status; return { [key]: value };
    };
    const conjunction = (): Json => { const a = [atom()]; while (t.peek() === 'and') { t.pop(); a.push(atom()); } return a.length === 1 ? a[0] : { all: a }; };
    const expr = (): Json => { const a = [conjunction()]; while (t.peek() === 'or') { t.pop(); a.push(conjunction()); } return a.length === 1 ? a[0] : { any: a }; };
    const c = expr(); t.done(); return c;
  }
  prepare(seq: Line[]) {
    const result: { n: Line; hs: Map<string, Line>; bs: Line[] }[] = []; let i = 0, pending: string | undefined;
    while (i < seq.length) {
      const n = seq[i++];
      if (n.text.startsWith('@')) { if (pending || n.block || !/^@[a-z][a-z0-9_]*$/.test(n.text)) fail('E_MARKER', n.number, '标记必须是独占一行的 @英文id'); pending = n.text.slice(1); continue; }
      n.mark = pending; pending = undefined;
      if (['failed', 'insufficient', 'rejected', 'elif ', 'else', 'on failure'].some(x => n.text.startsWith(x))) fail('E_ORPHAN_HANDLER', n.number, '此分支没有可关联的前置语句', '检查缩进及分支是否紧邻所属动作');
      const hs = new Map<string, Line>(), bs: Line[] = [];
      if (n.text.startsWith('if ')) { bs.push(n); while (i < seq.length && (seq[i].text.startsWith('elif ') || seq[i].text === 'else')) { if (bs.at(-1)!.text === 'else') fail('E_BRANCH', seq[i].number, 'else 必须为最后分支'); bs.push(seq[i++]); } }
      else while (i < seq.length && ['failed', 'insufficient', 'rejected'].includes(seq[i].text)) { const h = seq[i++]; if (hs.has(h.text)) fail('E_HANDLER', h.number, '重复处理块'); hs.set(h.text, h); }
      result.push({ n, hs, bs });
    }
    if (pending) fail('E_MARKER', seq.at(-1)!.number, '标记后缺少语句'); return result;
  }
  node(n: Line, type: string, params: Json, outputs: Json): string {
    const id = n.mark || `n_${n.number}`; if (this.used.has(id)) fail('E_DUPLICATE_ID', n.number, '重复节点标记 ' + id);
    this.used.add(id); this.nodes.push({ id, type, params, outputs }); this.maps[this.graph + '/' + id] = { file: this.filename, line: n.number, column: 1, statement: n.text }; return id;
  }
  sequence(seq: Line[], cont: string | null, fallback: string | null = null, handler = false): string {
    const prepared = this.prepare(seq); if (!prepared.length) fail('E_EMPTY_BLOCK', 1, '空语句块');
    prepared.forEach(({ n }, j) => { if (n.text === 'end' && j !== prepared.length - 1) fail('E_UNREACHABLE', prepared[j + 1].n.number, 'end 后的语句不可达'); });
    let entry = cont;
    for (const { n, hs, bs } of prepared.reverse()) {
      if (bs.length) {
        let no = entry;
        for (const b of [...bs].reverse()) { this.block(b); const yes = this.sequence(b.children, entry, fallback, handler); if (b.text === 'else') no = yes; else { if (no === null) fail('E_MISSING_END', b.number, '条件未匹配时没有结束路径', '在 if 块后增加 end 或完整 else'); no = this.node(b, 'condition', { when: this.condition(b.text.slice(b.text.indexOf(' ') + 1), b.number) }, { yes, no }); } }
        entry = no; continue;
      }
      if (n.text === 'end') { if (n.block || hs.size) fail('E_SYNTAX', n.number, 'end 不接受块'); entry = this.node(n, 'end', { result: 'completed' }, {}); continue; }
      if (entry === null) fail('E_MISSING_END', n.number, '该路径缺少 end');
      const t = new Tokens(n.text, n.number), cmd = t.pop(), allowed: string[] = [], outputs: Json = { next: entry }; let params: Json = {}, type = '';
      const exitFor = (name: string, def: string | null = null): string => { allowed.push(name); const h = hs.get(name); if (h) { this.block(h); return this.sequence(h.children, null, null, true); } if (def) return def; fail(name === 'failed' ? 'E_MISSING_FAILURE_HANDLER' : 'E_MISSING_' + name.toUpperCase(), n.number, `${cmd}${n.mark ? ' 节点 ' + n.mark : ''} 缺少 ${name}: 处理块`, `在动作后同级添加 ${name}:` + (name === 'failed' ? '，或在入口末尾添加 on failure:' : '')); };
      if (handler && !['say', 'fade'].includes(cmd)) fail('E_HANDLER_ACTION', n.number, '首版处理块仅支持 say / fade / end');
      if (cmd === 'say') {
        const actor = this.actor(t.pop(), n.number), text = t.pop(); if (!text.startsWith('"')) fail('E_STRING', n.number, '台词必须用双引号'); let value: string; try { value = JSON.parse(text); } catch { fail('E_STRING', n.number, '无效台词转义'); }
        const key = this.graph + '.' + (n.mark || `n_${n.number}`); this.package.texts[key] = value; type = 'dialogue'; params = { speaker: actor.id, textKey: key, waitForClose: true }; t.done();
      } else if (['move', 'face', 'wait'].includes(cmd)) { [type, params] = this.action(n); outputs.failed = exitFor('failed', fallback); }
      else if (cmd === 'parallel') {
        this.block(n); const kw = t.options(); keys(kw, ['timeout'], n.number); const timeout = number(kw.timeout, n.number, 'timeout', .1, 30, true);
        if (n.children.length < 2 || n.children.length > 4) fail('E_PARALLEL', n.number, 'parallel 需要 2～4 条动作'); const actors = new Set<string>();
        const actions = n.children.map((a, i) => { if (a.block) fail('E_PARALLEL', a.number, '并行组不支持嵌套块'); const [type, params] = this.action(a); if (actors.has(params.actor)) fail('E_PARALLEL_CONFLICT', a.number, '同一演员不能执行两项并行动作'); if (params.actor) actors.add(params.actor); return { id: `action_${i}`, type, params }; });
        type = 'parallel'; params = { actions, timeout }; outputs.failed = exitFor('failed', fallback);
      } else if (cmd === 'fade') { const kw = t.options(); keys(kw, ['to', 'duration'], n.number); type = 'screen.fade'; params = { to: number(kw.to, n.number, 'to', 0, 1), duration: number(kw.duration, n.number, 'duration', 0, 5, true), wait: true }; }
      else if (cmd === 'accept') { t.pop('quest'); type = 'quest.add'; params = { quest: this.ref(this.quests, t.pop(), n.number, '任务') }; t.done(); outputs.rejected = exitFor('rejected'); }
      else if (cmd === 'finish') { t.pop('task'); const [quest, task] = this.questTask(t); t.done(); type = 'task.setStatus'; params = { quest, task, status: 'finished' }; this.warnings.push({ line: n.number, code: 'W_TASK_GUARD', message: '请确认此路径只完成活动阶段；运行器会跳过非活动阶段。' }); }
      else if (cmd === 'take' || cmd === 'transfer') {
        const item = this.ref(this.items, t.pop(), n.number, '物品'); t.pop('count'); t.pop('='); const quantity = this.quantity(t.value(), n.number); t.pop('from'); if (t.pop() !== '玩家') fail('E_CAPABILITY', n.number, '当前只支持从玩家队伍库存取出物品'); params = { owner: 'player', item, quantity }; outputs.insufficient = exitFor('insufficient');
        if (cmd === 'transfer') { t.pop('to'); params.recipient = this.actor(t.pop(), n.number).id; type = 'inventory.transfer'; outputs.failed = exitFor('failed', fallback); } else type = 'inventory.remove'; t.done();
      } else fail('E_CAPABILITY', n.number, '未接入命令 ' + cmd, '已支持 say/move/face/wait/fade/parallel/accept/finish/take/transfer/end');
      if (n.block && cmd !== 'parallel') fail('E_BLOCK', n.number, '此原子动作不接受子块'); const extra = [...hs.keys()].filter(x => !allowed.includes(x)); if (extra.length) fail('E_HANDLER', n.number, '不适用于此命令的处理块：' + extra.join(', ')); entry = this.node(n, type, params, outputs);
    }
    return entry!;
  }
  action(n: Line): [string, Json] {
    const t = new Tokens(n.text, n.number), cmd = t.pop();
    if (cmd === 'wait') { const duration = number(t.value(), n.number, 'duration', 0, 30, true); t.done(); return ['wait', { duration }]; }
    if (!['move', 'face'].includes(cmd)) fail('E_PARALLEL_ACTION', n.number, '并行只接受 move / face / wait');
    const actor = this.actor(t.pop(), n.number); if (!actor.prefabRef) fail('E_CAPABILITY', n.number, '只支持移动/转向配置创建的演员');
    if (cmd === 'move') {
      t.pop('to'); const v = t.value(); let target: Json;
      if (isCall(v)) { if (v.call !== 'near' || v.args.length !== 1) fail('E_TARGET', n.number, '内联目标只支持 near(演员, distance=数值)'); keys(v.kwargs, ['distance'], n.number); const other = this.actor(v.args[0], n.number).id, distance = number(v.kwargs.distance, n.number, 'distance', .8, 10); if (other === actor.id) fail('E_TARGET', n.number, '不能走近自己'); target = { kind: 'actor', actor: other, distance }; }
      else target = { kind: 'point', point: this.ref(this.points, v, n.number, '点位').id };
      const kw = t.options(); keys(kw, ['speed', 'stop', 'timeout'], n.number); return ['actor.move', { actor: actor.id, target, speed: number(kw.speed ?? 2, n.number, 'speed', .1, 8), stop: number(kw.stop ?? .2, n.number, 'stop', .1, 1), timeout: number(kw.timeout ?? new Seconds(12), n.number, 'timeout', .1, 30, true) }];
    }
    t.pop('toward'); const other = this.actor(t.pop(), n.number).id, kw = t.options(); keys(kw, ['duration'], n.number); if (other === actor.id) fail('E_TARGET', n.number, '不能面向自己'); return ['actor.face', { actor: actor.id, toward: other, duration: number(kw.duration ?? new Seconds(.5), n.number, 'duration', .01, 5, true) }];
  }
  compile(): { package: Json; mapping: Json } {
    const headers: Record<string, string> = Object.create(null), entries: Line[] = []; let started = false;
    for (const n of this.root) {
      const word = n.text.split(/\s+/)[0];
      if (['story', 'dsl', 'target'].includes(word)) { const t = new Tokens(n.text, n.number); t.pop(); const value = t.value(); t.done(); if (started || Object.hasOwn(headers, word) || n.block || typeof value !== 'string' || !value.trim()) fail('E_HEADER', n.number, '重复、空值或位置错误的文件头'); headers[word] = value; }
      else if (n.text.startsWith('on ')) { started = true; entries.push(n); }
      else if (word === 'quest') { if (started) fail('E_DECLARATION', n.number, '任务声明必须位于入口之前'); this.declareQuest(n); }
      else if (word.startsWith('@')) fail('E_MARKER_SCOPE', n.number, '节点标记需要放在交互入口的语句块内', '入口本身使用 on interact 的 id 参数命名');
      else { if (started || n.block) fail('E_DECLARATION', n.number, '声明必须位于入口之前且不带子块'); this.declare(n); }
    }
    if (Object.keys(headers).length !== 3 || headers.dsl !== (this.independent ? '0.3-draft' : '0.2-draft') || headers.target !== (this.independent ? 'playground-quests-v3' : 'playground-spatial-v2')) fail('E_HEADER', 1, '需要 story、dsl 和对应的 target 文件头');
    if (this.independent) { if (!this.package.quests.length) fail('E_QUEST', 1, '缺少独立任务声明'); this.package.packageId = logical('story', headers.story); }
    if (!entries.length) fail('E_ENTRY', 1, '缺少交互入口'); const bindings = new Set<string>(), ids = new Set<string>();
    for (const n of entries) {
      this.block(n); const t = new Tokens(n.text, n.number); t.pop('on'); if (t.pop() !== 'interact') fail('E_CAPABILITY', n.number, '当前仅支持 on interact 入口；区域、场景与任务入口尚未接入');
      const actor = this.actor(t.pop(), n.number), kw = t.options(); keys(kw, ['id', 'blockPlayer', 'blockCamera'], n.number); const id = kw.id;
      if (typeof id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(id)) fail('E_ENTRY', n.number, '入口需要 id=小写英文标识');
      if (!actor.bindingKey && !this.independent) fail('E_ENTRY', n.number, '入口必须绑定已有 scene 演员'); const key = actor.bindingKey || 'actor:' + actor.id;
      if (bindings.has(key) || ids.has(id)) fail('E_ENTRY', n.number, '重复入口绑定或 id'); bindings.add(key); ids.add(id); this.graph = id; this.nodes = []; this.used = new Set();
      const body = [...n.children], handlers = body.filter(x => x.text === 'on failure'); let fallback: string | null = null;
      if (handlers.length) { if (handlers.length !== 1 || handlers[0] !== body.at(-1)) fail('E_HANDLER', handlers[0].number, '入口 on failure 必须唯一并位于末尾', '先完成正常路径的 end，再放 on failure: 作为入口最后的子块'); const h = body.pop()!; this.block(h); fallback = this.sequence(h.children, null, null, true); }
      const entry = this.sequence(body, null, fallback), settings = { blockPlayer: kw.blockPlayer ?? true, blockCamera: kw.blockCamera ?? false };
      if (Object.values(settings).some(v => typeof v !== 'boolean')) fail('E_PARAM', n.number, '控制选项必须为 true / false');
      const indexed = new Map(this.nodes.map(x => [x.id, x])), seen = new Set<string>(); const visit = (id: string) => { if (seen.has(id)) return; seen.add(id); Object.values(indexed.get(id)!.outputs).forEach(dest => visit(dest as string)); }; visit(entry);
      const nodes = [...this.nodes].reverse().filter(x => seen.has(x.id)); if (nodes.length > 200) fail('E_LIMIT', n.number, '图超过 200 节点');
      const graph = { id, entry, settings, nodes };
      if (this.independent) { this.package.graphs.push(graph); this.package.bindings.push({ id: 'bind_' + id, bindingKey: key, enabledWhen: { always: true }, interaction: { graph: id, trigger: 'interact', profileRef: 'playground_interact', reentry: 'ignoreWhileRunning' } }); }
      else {
        const binding = this.package.bindings.find((x: Json) => x.bindingKey === key); if (!binding?.interaction) fail('E_ENTRY', n.number, '上下文未注册交互绑定'); const old = binding.interaction.graph;
        if (this.package.graphs.some((g: Json) => g.id === id && g.id !== old)) fail('E_ENTRY', n.number, '入口 ID 与其他图冲突'); this.package.graphs[this.package.graphs.findIndex((g: Json) => g.id === old)] = graph; binding.interaction.graph = id;
      }
    }
    for (const b of this.package.bindings) {
      if (!b.interaction || bindings.has(b.bindingKey)) continue;
      let a = [...this.actors.values()].find(a => a.bindingKey === b.bindingKey);
      if (!a) { a = { id: logical('a', b.bindingKey), name: '艾琳', bindingKey: b.bindingKey }; this.package.spatial.actors.push(a); }
      const g = this.package.graphs.find((g: Json) => g.id === b.interaction.graph); for (const n of g.nodes) if (n.type === 'dialogue') n.params.speaker = a.id;
    }
    for (const [key, limit] of [['actors', 8], ['regions', 16], ['points', 32]] as const) { const values = this.package.spatial[key]; if (values.length > limit) fail('E_LIMIT', 1, `${key} 超过 ${limit} 个`); if (new Set(values.map((x: Json) => x.id)).size !== values.length) fail('E_ID_COLLISION', 1, '生成的逻辑 ID 冲突'); }
    const live = new Set(this.package.graphs.flatMap((g: Json) => g.nodes.map((n: Json) => g.id + '/' + n.id))); this.maps = Object.fromEntries(Object.entries(this.maps).filter(([k]) => live.has(k)));
    this.package.revision = 'dsl-' + hash(stable(this.package)).slice(0, 12);
    return { package: this.package, mapping: { version: headers.dsl, file: this.filename, title: headers.story, nodes: this.maps, warnings: this.warnings } };
  }
}
export function compileSource(source: string, context: Json, filename = '<story>') { return new Compiler(source, context, filename).compile(); }
