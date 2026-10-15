import { Diagnostic } from './syntax';
import type { Json } from './compiler';
const check = (ok: unknown, path: string, message: string): void => { if (!ok) throw new Diagnostic('E_TARGET_VALIDATION', 1, '目标运行器拒绝编译产物', path + ': ' + message); };
const obj = (v: any, p: string): Json => { check(v && typeof v === 'object' && !Array.isArray(v), p, 'expected object'); return v; };
const arr = (v: any, p: string): any[] => { check(Array.isArray(v), p, 'expected array'); return v; };
const str = (v: any, p: string): string => { check(typeof v === 'string' && !!v.trim(), p, 'expected nonempty string'); return v; };
const bool = (v: any, p: string): boolean => { check(typeof v === 'boolean', p, 'expected boolean'); return v; };
const num = (v: any, p: string, lo: number, hi: number, integer = false): number => { check(typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi && (!integer || Number.isInteger(v)), p, 'number outside range'); return v; };
function fields(v: any, p: string, required: string, optional = '') { obj(v, p); const req = required.split(' ').filter(Boolean), allowed = (required + ' ' + optional).split(' '); req.forEach(k => check(Object.hasOwn(v, k), p + '/' + k, 'required')); Object.keys(v).forEach(k => check(allowed.includes(k), p + '/' + k, 'unsupported field')); }
function index(v: any, p: string, min: number, max: number): Map<string, Json> { const list = arr(v, p); check(list.length >= min && list.length <= max, p, 'entry count outside range'); const result = new Map<string, Json>(); list.forEach(x => { obj(x, p); const id = str(x.id, p); check(/^[a-z][a-z0-9_]*$/.test(id) && !result.has(id), p, 'invalid or duplicate id'); result.set(id, x); }); return result; }
const sceneActors = ['world.witch_town', 'world.witch_forest', 'world.witch_outpost'];
const pickups = ['world.cheese_1', 'world.cheese_2', 'world.cheese_3'];
const item = (id: any, p: string) => check(['ruined_cheese', 'high_potion', 'revive_potion', 'magic_crystal'].includes(id), p, 'unknown item');
function acyclic(edges: Map<string, string[]>, starts: string[], p: string, all = false) {
  const stack = new Set<string>(), seen = new Set<string>();
  function visit(id: string) { check(!stack.has(id), p + '/' + id, 'cycle'); if (seen.has(id)) return; check(edges.has(id), p, 'unknown reference'); seen.add(id); stack.add(id); edges.get(id)!.forEach(visit); stack.delete(id); }
  starts.forEach(visit); if (all) check(seen.size === edges.size, p, 'unreachable node');
}
/** Semantic parity with StoryConfigPackage + StorySpatialSchema, without Unity/PowerShell. */
export function validatePackage(root: Json): void {
  fields(root, 'package', 'schemaVersion packageId revision stage capabilityProfile quests graphs bindings texts', 'spatial');
  const version = root.schemaVersion, independent = version === '0.4.0', spatial = version !== '0.2.0';
  check(['0.2.0', '0.3.0', '0.4.0'].includes(version), 'schemaVersion', 'unsupported version'); check(spatial === Object.hasOwn(root, 'spatial'), 'spatial', 'version mismatch');
  check(independent ? /^[a-z][a-z0-9_]{0,63}$/.test(str(root.packageId, 'packageId')) : root.packageId === 'forest_story', 'packageId', 'unsupported package');
  check(root.capabilityProfile === (independent ? 'playground-quests-v3' : spatial ? 'playground-spatial-v2' : 'playground-v1'), 'capabilityProfile', 'unsupported profile'); str(root.revision, 'revision'); check(['dsl', 'polish'].includes(root.stage), 'stage', 'invalid stage');
  obj(root.texts, 'texts'); Object.values(root.texts).forEach(v => check(typeof v === 'string', 'texts', 'expected string'));
  const text = (key: any) => check(Object.hasOwn(root.texts, key) && typeof root.texts[key] === 'string', 'texts/' + key, 'missing text');
  let actors = new Map<string, Json>(), regions = new Map<string, Json>(), points = new Map<string, Json>();
  const actor = (id: any) => { check(actors.has(id), 'actor/' + id, 'unknown actor'); return actors.get(id)!; };
  const vector = (v: any, p: string) => { check(arr(v, p).length === 3, p, 'three components required'); v.forEach((x: any) => num(x, p, -50, 50)); };
  if (spatial) {
    fields(root.spatial, 'spatial', 'actors regions points'); actors = index(root.spatial.actors, 'actors', 0, 8); regions = index(root.spatial.regions, 'regions', 0, 16); points = index(root.spatial.points, 'points', 0, 32);
    const used = new Set<string>();
    for (const [id, a] of actors) {
      fields(a, id, 'id name', 'bindingKey prefabRef spawn'); str(a.name, id);
      if ('bindingKey' in a) { check(!('prefabRef' in a) && !('spawn' in a) && sceneActors.includes(a.bindingKey) && !used.has(a.bindingKey), id, 'invalid or duplicate binding'); used.add(a.bindingKey); }
      else { check(['knight', 'worker'].includes(a.prefabRef), id, 'unknown prefab'); fields(a.spawn, id, 'anchor offset'); check('bindingKey' in actor(a.spawn.anchor), id, 'spawn anchor must be scene actor'); vector(a.spawn.offset, id); }
    }
    for (const [id, r] of regions) { fields(r, id, 'id name anchor radius'); str(r.name, id); actor(r.anchor); num(r.radius, id, .5, 30); }
    for (const [id, p] of points) {
      if (p.kind === 'offset') { fields(p, id, 'id kind anchor offset'); actor(p.anchor); vector(p.offset, id); }
      else if (p.kind === 'near') { fields(p, id, 'id kind actor minDistance maxDistance seed'); actor(p.actor); num(p.minDistance, id, .5, 20); num(p.maxDistance, id, .5, 30); check(p.maxDistance >= p.minDistance, id, 'invalid distance range'); num(p.seed, id, 0, 1e6, true); }
      else if (p.kind === 'area') { fields(p, id, 'id kind region seed'); check(regions.has(p.region), id, 'unknown region'); num(p.seed, id, 0, 1e6, true); }
      else check(false, id, 'unknown point kind');
    }
  }
  const quests = index(root.quests, 'quests', 1, independent ? 4 : 1), tasks = new Map<string, Json>(), owners = new Map<string, string>();
  if (!independent) check(quests.has('forest_cheese'), 'quests', 'profile binds forest_cheese');
  for (const [id, q] of quests) {
    fields(q, id, 'id nameKey repeatable tasks rewards'); text(q.nameKey); check(bool(q.repeatable, id) === false, id, 'repeatable unsupported');
    for (const [tid, t] of index(q.tasks, id + '/tasks', 0, 32)) { check(!tasks.has(tid), tid, 'task id not unique'); tasks.set(tid, t); owners.set(tid, id); }
    fields(q.rewards, id, 'items experienceProfileRef'); check(q.rewards.experienceProfileRef === (independent ? 'none' : 'level_based_20'), id, 'unknown experience profile');
    arr(q.rewards.items, id).forEach(r => { fields(r, id, 'item quantity'); item(r.item, id); num(r.quantity, id, 1, 999, true); });
  }
  check(independent ? tasks.size >= 1 && tasks.size <= 32 : [...tasks.keys()].sort().join(',') === 'collect,deliver,meet,outpost', 'tasks', 'invalid task set');
  const questRef = (id: any, p: string) => check(quests.has(id), p, 'unknown quest');
  const taskRef = (v: Json, p: string) => { questRef(v.quest, p); check(tasks.has(v.task) && owners.get(v.task) === v.quest, p, 'unknown task or wrong quest owner'); };
  function condition(v: any, p: string, depth = 0): void {
    check(depth < 64, p, 'condition too deep'); obj(v, p); check(Object.keys(v).length === 1, p, 'exactly one condition operator required'); const op = Object.keys(v)[0], c = v[op];
    if (op === 'always') bool(c, p);
    else if (op === 'all' || op === 'any') { check(arr(c, p).length > 0, p, 'empty condition group'); c.forEach((x: any) => condition(x, p, depth + 1)); }
    else if (op === 'not') condition(c, p, depth + 1);
    else if (op === 'taskStatus') { fields(c, p, 'quest task is'); taskRef(c, p); check(['inactive', 'active', 'finished', 'failed'].includes(c.is), p, 'invalid task status'); }
    else if (op === 'questStatus') { fields(c, p, 'quest is'); questRef(c.quest, p); check(['notAdded', 'inactive', 'active', 'finished', 'failed'].includes(c.is), p, 'invalid quest status'); }
    else if (op === 'inventory') { fields(c, p, 'owner item gte'); check(c.owner === 'player', p, 'only player inventory'); item(c.item, p); num(c.gte, p, 0, 999, true); }
    else check(false, p, 'unknown condition');
  }
  function dependencies(c: Json, p: string): string[] { if ('always' in c) { check(c.always === true, p, 'activation requires always true'); return []; } if ('all' in c) return c.all.flatMap((v: Json) => dependencies(v, p)); check(c.taskStatus?.is === 'finished', p, 'activation requires finished task dependencies'); return [c.taskStatus.task]; }
  const taskEdges = new Map<string, string[]>();
  for (const [id, t] of tasks) {
    fields(t, id, 'id nameKey activate complete finishQuest', 'progress'); text(t.nameKey); bool(t.finishQuest, id); fields(t.activate, id, 'mode when'); check(t.activate.mode === 'auto', id, 'activation must be auto'); condition(t.activate.when, id); const deps = dependencies(t.activate.when, id); taskEdges.set(id, deps);
    if (independent) deps.forEach(d => check(owners.get(d) === owners.get(id), id, 'cross-quest activation'));
    fields(t.complete, id, 'mode'); check(['auto', 'manual'].includes(t.complete.mode) && (t.complete.mode === 'auto') === ('progress' in t), id, 'invalid completion mode');
    if (t.progress) { const r = t.progress; fields(r, id, 'kind targetRef required countFrom'); check(['inventory', 'collected'].includes(r.kind) && r.countFrom === 'taskActivation', id, 'unsupported progress'); item(r.targetRef, id); num(r.required, id, 1, 999, true); }
  }
  if (independent) for (const id of quests.keys()) check([...tasks].filter(([tid, t]) => owners.get(tid) === id && t.finishQuest).length === 1, id, 'exactly one final task required');
  acyclic(taskEdges, [...tasks.keys()], 'tasks');
  const graphs = index(root.graphs, 'graphs', independent ? 1 : 3, independent ? 8 : 3);
  function action(type: string, a: Json, p: string) {
    if (type === 'wait') { fields(a, p, 'duration'); num(a.duration, p, 0, 30); return; }
    const owner = actor(a.actor); check(owner.prefabRef, p, 'action requires owned actor');
    if (type === 'actor.move') {
      fields(a, p, 'actor target speed stop timeout'); num(a.speed, p, .1, 8); num(a.stop, p, .1, 1); num(a.timeout, p, .1, 30); const t = obj(a.target, p);
      if (t.kind === 'point') { fields(t, p, 'kind point'); check(points.has(t.point), p, 'unknown point'); }
      else { check(t.kind === 'actor', p, 'unknown target'); fields(t, p, 'kind actor distance'); actor(t.actor); check(t.actor !== a.actor, p, 'cannot approach self'); num(t.distance, p, .8, 10); }
    } else if (type === 'actor.face') { fields(a, p, 'actor toward duration'); actor(a.toward); check(a.toward !== a.actor, p, 'cannot face self'); num(a.duration, p, .01, 5); }
    else check(false, p, 'unsupported spatial action');
  }
  for (const [id, g] of graphs) {
    fields(g, id, 'id entry settings nodes'); fields(g.settings, id, 'blockPlayer blockCamera'); bool(g.settings.blockPlayer, id); bool(g.settings.blockCamera, id);
    const nodes = index(g.nodes, id + '/nodes', 1, 200), edges = new Map<string, string[]>();
    for (const [nid, n] of nodes) {
      const p = id + '/' + nid; fields(n, p, 'id type params outputs'); const a = obj(n.params, p), outputs = obj(n.outputs, p); let exits = 'next';
      switch (n.type) {
        case 'condition': fields(a, p, 'when'); condition(a.when, p); exits = 'yes no'; break;
        case 'dialogue': fields(a, p, 'speaker textKey waitForClose'); if (spatial) actor(a.speaker); else check(a.speaker === 'speaker', p, 'invalid speaker'); text(a.textKey); check(a.waitForClose === true, p, 'dialogue must wait'); break;
        case 'quest.add': fields(a, p, 'quest'); questRef(a.quest, p); exits = 'next rejected'; break;
        case 'task.setStatus': fields(a, p, 'quest task status'); taskRef(a, p); check(a.status === 'finished', p, 'invalid status'); break;
        case 'inventory.remove': case 'inventory.transfer': fields(a, p, n.type === 'inventory.transfer' ? 'owner item quantity recipient' : 'owner item quantity'); check(a.owner === 'player', p, 'only player inventory'); item(a.item, p); num(a.quantity, p, 1, 999, true); exits = 'next insufficient'; if (n.type === 'inventory.transfer') { check(spatial, p, 'spatial required'); actor(a.recipient); exits += ' failed'; } break;
        case 'screen.fade': fields(a, p, 'to duration wait'); num(a.to, p, 0, 1); num(a.duration, p, 0, 5); check(a.wait === true, p, 'fade must wait'); break;
        case 'actor.move': case 'actor.face': case 'wait': check(spatial, p, 'spatial required'); action(n.type, a, p); exits = 'next failed'; break;
        case 'parallel': {
          check(spatial, p, 'spatial required'); fields(a, p, 'actions timeout'); num(a.timeout, p, .1, 30); const actions = arr(a.actions, p); check(actions.length >= 2 && actions.length <= 4, p, '2..4 parallel actions'); const ids = new Set<string>(), actors = new Set<string>();
          actions.forEach(x => { fields(x, p, 'id type params'); str(x.id, p); check(!ids.has(x.id), p, 'duplicate action id'); ids.add(x.id); action(x.type, obj(x.params, p), p); if (x.params.actor) { check(!actors.has(x.params.actor), p, 'parallel actor conflict'); actors.add(x.params.actor); } }); exits = 'next failed'; break;
        }
        case 'end': fields(a, p, 'result'); check(a.result === 'completed', p, 'invalid result'); exits = ''; break;
        default: check(false, p, 'unknown node type');
      }
      fields(outputs, p + '/outputs', exits); Object.values(outputs).forEach(x => check(typeof x === 'string' && nodes.has(x), p, 'unknown node reference')); edges.set(nid, Object.values(outputs));
    }
    acyclic(edges, [str(g.entry, id)], id, true);
  }
  const bindings = index(root.bindings, 'bindings', independent ? 1 : 6, independent ? 11 : 6), keys = new Set<string>(), bound = new Set<string>();
  for (const [id, b] of bindings) {
    fields(b, id, 'id bindingKey enabledWhen', 'interaction collectorProfileRef'); const key = str(b.bindingKey, id); check(!keys.has(key), id, 'duplicate scene binding'); keys.add(key);
    const owned = independent && key.startsWith('actor:') && actors.get(key.slice(6))?.prefabRef; check(owned || [...sceneActors, ...pickups].includes(key), id, 'unknown binding'); condition(b.enabledWhen, id); check(('interaction' in b) !== ('collectorProfileRef' in b), id, 'one binding role required');
    if (b.interaction) { check(owned || sceneActors.includes(key), id, 'NPC binding required'); const i = b.interaction; fields(i, id, 'graph trigger profileRef reentry'); check(graphs.has(i.graph) && i.trigger === 'interact' && i.profileRef === 'playground_interact' && i.reentry === 'ignoreWhileRunning', id, 'invalid interaction'); check(!bound.has(i.graph), id, 'duplicate graph binding'); bound.add(i.graph); }
    else check(pickups.includes(key) && b.collectorProfileRef === 'ruined_cheese_single', id, 'unknown collector profile');
  }
  check(bound.size === graphs.size, 'bindings', 'each graph needs one binding');
}
