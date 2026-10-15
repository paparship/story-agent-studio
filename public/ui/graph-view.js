/* Read-only story canvas. Layout, navigation and inspection stay outside workflow state. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const TYPES = {condition: '条件判断', dialogue: '对话', 'quest.add': '接取任务',
    'task.setStatus': '更新任务阶段', parallel: '并行行动', 'actor.move': '角色移动',
    'actor.face': '角色转向', 'inventory.transfer': '交付物品', 'inventory.remove': '扣除物品',
    'screen.fade': '画面渐变', wait: '等待', end: '流程结束'};
  const STATUS = {notAdded: '未接取', active: '进行中', finished: '已完成', inactive: '未开始'};
  let serial = 0;
  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function svg(tag, attrs = {}, text) {
    const el = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function shorten(text, length = 23) {
    const chars = Array.from(String(text));
    return chars.length > length ? chars.slice(0, length - 1).join('') + '…' : chars.join('');
  }
  function route(points) {
    // Dagre reserves room for labels and routes each branch independently.
    if (!points.length) return '';
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[i - 1], b = points[i], c = points[i + 1];
      const before = Math.hypot(b.x - a.x, b.y - a.y), after = Math.hypot(c.x - b.x, c.y - b.y);
      const radius = Math.min(9, before / 3, after / 3);
      if (!before || !after) continue;
      const p = {x: b.x + (a.x - b.x) * radius / before, y: b.y + (a.y - b.y) * radius / before};
      const q = {x: b.x + (c.x - b.x) * radius / after, y: b.y + (c.y - b.y) * radius / after};
      path += ` L ${p.x} ${p.y} Q ${b.x} ${b.y} ${q.x} ${q.y}`;
    }
    const last = points.at(-1);
    return path + ` L ${last.x} ${last.y}`;
  }

  class StoryGraphView {
    constructor(host, data, packageData) {
      this.host = host; this.graphs = data.graphs; this.package = packageData;
      this.prefix = 'story-canvas-' + ++serial; this.direction = 'TB';
      this.autoFit = true; this.selected = null; this.camera = {scale: 1, x: 0, y: 0};
      this.actors = new Map((packageData.spatial?.actors || []).map(actor => [actor.id, actor.name]));
      this.taskNames = new Map(); this.questNames = new Map();
      for (const quest of packageData.quests || []) {
        this.questNames.set(quest.id, this.text(quest.nameKey) || quest.id);
        for (const task of quest.tasks) this.taskNames.set(quest.id + '/' + task.id, this.text(task.nameKey) || task.id);
      }
      this.build();
      this.resize = new ResizeObserver(() => {
        if (this.stage.clientWidth && this.stage.clientHeight) {
          if (this.autoFit) this.fit(); else this.transform();
        }
      });
      this.resize.observe(this.stage);
      this.keyHandler = event => {
        if (this.expanded && event.key === 'Tab') {
          const panel = this.host.closest('.detail');
          const controls = [...panel.querySelectorAll('button, select, a[href], [tabindex="0"]')]
            .filter(el => !el.disabled && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
          const first = controls[0], last = controls.at(-1), active = document.activeElement;
          if (!panel.contains(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
            event.preventDefault(); (event.shiftKey ? last : first)?.focus();
          }
        }
        if (event.key === 'Escape') {
          if (!this.inspector.hidden) this.closeInspector(); else if (this.expanded) this.expand(false);
        }
      };
      document.addEventListener('keydown', this.keyHandler);
      if (this.graphs.length) this.showGraph(this.graphs[0].id);
    }

    text(key) { return this.package.texts?.[key] || ''; }
    graphName(graph) {
      const binding = this.package.bindings?.find(b => b.interaction.graph === graph.id);
      const actor = this.package.spatial?.actors?.find(a => (a.bindingKey || 'actor:' + a.id) === binding?.bindingKey);
      return actor ? actor.name + ' · ' + graph.id : graph.id;
    }
    conditionText(condition) {
      if (condition.questStatus) {
        const q = condition.questStatus;
        return (this.questNames.get(q.quest) || q.quest) + ' · ' + (STATUS[q.is] || q.is);
      }
      if (condition.taskStatus) {
        const t = condition.taskStatus;
        return (this.taskNames.get(t.quest + '/' + t.task) || t.task) + ' · ' + (STATUS[t.is] || t.is);
      }
      if (condition.inventory) return '背包数量 ≥ ' + condition.inventory.gte;
      if (condition.all) return condition.all.length + ' 个条件全部成立';
      if (condition.any) return condition.any.length + ' 个条件任一成立';
      if (condition.not) return '条件取反';
      return condition.always ? '始终成立' : '条件不成立';
    }
    describe(node) {
      const p = node.params, title = TYPES[node.type] || node.type;
      let body = '';
      if (node.type === 'condition') body = this.conditionText(p.when);
      else if (node.type === 'dialogue') body = this.text(p.textKey);
      else if (node.type === 'quest.add') body = this.questNames.get(p.quest) || p.quest;
      else if (node.type === 'task.setStatus') body = (this.taskNames.get(p.quest + '/' + p.task) || p.task) + ' · ' + (STATUS[p.status] || p.status);
      else if (node.type === 'parallel') body = p.actions.map(a => TYPES[a.type] || a.type).join(' + ');
      else if (node.type === 'actor.move' || node.type === 'actor.face') body = this.actors.get(p.actor) || p.actor;
      else if (node.type === 'end') body = '本次交互结束';
      else body = Object.keys(p).join(' · ');
      return {title, body, speaker: node.type === 'dialogue' ? this.actors.get(p.speaker) : ''};
    }

    button(label, action, className = '') {
      const button = element('button', className, label);
      button.type = 'button'; button.onclick = action; return button;
    }
    build() {
      this.host.replaceChildren(); this.host.classList.add('story-viewer');
      const toolbar = element('div', 'graph-toolbar');
      this.selector = element('select', 'graph-select'); this.selector.setAttribute('aria-label', '选择剧情图');
      for (const graph of this.graphs) {
        const option = element('option', '', this.graphName(graph)); option.value = graph.id; this.selector.append(option);
      }
      this.selector.onchange = () => this.showGraph(this.selector.value);
      this.count = element('span', 'graph-count');
      const tools = element('div', 'graph-tools');
      this.orientation = this.button('纵向', () => {
        this.direction = this.direction === 'TB' ? 'LR' : 'TB';
        this.orientation.textContent = this.direction === 'TB' ? '纵向' : '横向';
        this.render();
      }); this.orientation.title = '切换布局方向';
      this.percentage = this.button('100%', () => {this.autoFit = false; this.setZoom(1 / this.camera.scale);}, 'graph-percent');
      this.percentage.setAttribute('aria-label', '恢复百分之百缩放');
      this.expandButton = this.button('展开画布', () => this.expand(!this.expanded));
      tools.append(this.orientation, this.button('−', () => this.setZoom(1 / 1.25), 'graph-zoom-out'),
        this.percentage, this.button('+', () => this.setZoom(1.25), 'graph-zoom-in'),
        this.button('适配整图', () => {this.autoFit = true; this.fit();}), this.expandButton);
      tools.querySelector('.graph-zoom-out').setAttribute('aria-label', '缩小剧情图');
      tools.querySelector('.graph-zoom-in').setAttribute('aria-label', '放大剧情图');
      const help = element('div', 'graph-help');
      const helpButton = this.button('?', () => {}); helpButton.setAttribute('aria-label', '画布操作帮助');
      const tip = element('div', 'graph-help-tip', '拖动平移 · 滚轮缩放\n点击节点查看详情');
      tip.setAttribute('role', 'tooltip'); tip.id = 'graph-help-tip-' + (++serial); helpButton.setAttribute('aria-describedby', tip.id); help.append(helpButton, tip); tools.append(help);
      toolbar.append(this.selector, this.count, tools);
      this.stage = element('div', 'graph-stage'); this.stage.tabIndex = 0;
      this.stage.setAttribute('aria-label', '剧情图画布，拖动平移，滚轮缩放');
      this.surface = svg('svg', {class: 'graph-surface', width: '100%', height: '100%', 'aria-label': '剧情节点与分支连线'});
      this.stage.append(this.surface);
      this.inspector = element('div', 'graph-inspector'); this.inspector.hidden = true;
      this.mini = svg('svg', {class: 'graph-minimap', width: 136, height: 94, role: 'button', tabindex: 0, 'aria-label': '剧情图总览，点击定位'});
      this.stage.append(this.inspector, this.mini);
      const footer = element('div', 'graph-hint');
      footer.setAttribute('aria-label', '分支图例');
      for (const [kind, text] of [['success', '成立 / 继续'], ['failure', '否 / 失败']]) {
        const item = element('span', 'graph-legend-item');
        const dot = element('i', 'legend-dot ' + kind); dot.setAttribute('aria-hidden', 'true');
        item.append(dot, document.createTextNode(text)); footer.append(item);
      }
      this.stage.append(footer);
      this.host.append(toolbar, this.stage);
      this.bindNavigation();
    }

    showGraph(id) {
      this.graph = this.graphs.find(g => g.id === id); if (!this.graph) return;
      this.selector.value = id; this.closeInspector(); this.render();
    }
    render() {
      this.layout = StoryGraphLayout.layoutGraph(this.graph, dagre, this.direction);
      this.count.textContent = this.layout.nodes.length + ' 个节点';
      this.surface.replaceChildren();
      const defs = svg('defs');
      for (const [kind, color] of [['normal', '#8fa999'], ['alternate', '#bd9988']]) {
        const marker = svg('marker', {id: this.prefix + '-' + kind, markerWidth: 8, markerHeight: 8,
          refX: 7, refY: 4, orient: 'auto', markerUnits: 'userSpaceOnUse'});
        marker.append(svg('path', {d: 'M 1 1 L 7 4 L 1 7', fill: 'none', stroke: color, 'stroke-width': 1.3})); defs.append(marker);
      }
      this.surface.append(defs); this.world = svg('g', {class: 'graph-world'}); this.surface.append(this.world);
      this.edgeElements = [];
      for (const edge of this.layout.edges) {
        const alternate = ['no', 'failed', 'rejected', 'insufficient'].includes(edge.port);
        const group = svg('g', {class: 'graph-edge' + (alternate ? ' alternate' : ''), 'data-from': edge.from, 'data-to': edge.to});
        group.append(svg('path', {d: route(edge.points), class: 'graph-wire', 'marker-end': `url(#${this.prefix}-${alternate ? 'alternate' : 'normal'})`}));
        if (edge.label) {
          const label = svg('g', {class: 'graph-branch-label', transform: `translate(${edge.x},${edge.y})`});
          label.append(svg('rect', {x: -edge.width / 2, y: -11, width: edge.width, height: 22, rx: 11}),
            svg('text', {'text-anchor': 'middle', y: 4}, edge.label), svg('title', {}, edge.port)); group.append(label);
        }
        this.world.append(group); this.edgeElements.push({edge, element: group});
      }
      this.nodeElements = new Map();
      for (const positioned of this.layout.nodes) {
        const node = positioned.node, description = this.describe(node);
        const type = node.type === 'condition' ? 'condition' : node.type === 'dialogue' ? 'dialogue' : node.type === 'end' ? 'end' : 'action';
        const group = svg('g', {class: 'graph-card ' + type, transform: `translate(${positioned.x - positioned.width / 2},${positioned.y - positioned.height / 2})`,
          role: 'button', tabindex: 0, 'aria-label': `${description.title} ${node.id}`, 'data-node': node.id});
        group.append(svg('rect', {class: 'graph-card-body', width: positioned.width, height: positioned.height, rx: 9}));
        group.append(svg('rect', {class: 'graph-card-accent', x: 0, y: 17, width: 3, height: 22, rx: 1.5}));
        group.append(svg('text', {class: 'graph-card-title', x: 13, y: 23}, description.title + (description.speaker ? ' · ' + shorten(description.speaker, 6) : '')));
        group.append(svg('text', {class: 'graph-card-summary', x: 13, y: 42}, shorten(description.body, 15)));
        group.append(svg('text', {class: 'graph-card-id', x: 13, y: 59}, shorten(node.id, 25)));
        if (node.id === this.graph.entry) {
          group.append(svg('rect', {class: 'graph-entry-pill', x: 155, y: 9, width: 30, height: 17, rx: 4}),
            svg('text', {class: 'graph-entry-text', x: 170, y: 21, 'text-anchor': 'middle'}, '入口'));
        }
        group.append(svg('title', {}, description.body));
        group.onclick = () => {if (!this.moved) this.inspect(node);};
        group.onkeydown = event => {
          if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); this.inspect(node);}
        };
        this.world.append(group); this.nodeElements.set(node.id, group);
      }
      this.renderMini(); this.autoFit = true; this.fit();
      if (this.selected) this.highlight(this.selected);
    }

    fit() {
      const width = this.stage.clientWidth, height = this.stage.clientHeight;
      if (!width || !height || !this.layout) return;
      this.camera = StoryGraphLayout.fit(this.layout, width, height, 28); this.transform();
    }
    setZoom(factor, point) {
      this.autoFit = false;
      const x = point?.x ?? this.stage.clientWidth / 2, y = point?.y ?? this.stage.clientHeight / 2;
      this.camera = StoryGraphLayout.zoomAt(this.camera, factor, x, y); this.transform();
    }
    transform() {
      if (!this.world) return;
      const {scale, x, y} = this.camera;
      this.world.setAttribute('transform', `translate(${x},${y}) scale(${scale})`);
      this.percentage.textContent = Math.round(scale * 100) + '%';
      this.stage.style.backgroundSize = (20 * Math.max(scale, .45)) + 'px ' + (20 * Math.max(scale, .45)) + 'px';
      if (this.miniFrame) {
        this.miniFrame.setAttribute('x', -x / scale); this.miniFrame.setAttribute('y', -y / scale);
        this.miniFrame.setAttribute('width', this.stage.clientWidth / scale);
        this.miniFrame.setAttribute('height', this.stage.clientHeight / scale);
      }
    }
    renderMini() {
      this.mini.replaceChildren(); this.mini.setAttribute('viewBox', `0 0 ${this.layout.width} ${this.layout.height}`);
      for (const node of this.layout.nodes) this.mini.append(svg('rect', {x: node.x - node.width / 2, y: node.y - node.height / 2,
        width: node.width, height: node.height, rx: 12, fill: node.node.type === 'condition' ? '#d9cda9' : '#c0d5c5'}));
      this.miniFrame = svg('rect', {class: 'minimap-frame', fill: '#8fae9530', stroke: '#63836d', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke'});
      this.mini.append(this.miniFrame);
      this.mini.onclick = event => {
        const point = this.mini.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
        const local = point.matrixTransform(this.mini.getScreenCTM().inverse());
        this.autoFit = false; this.camera.x = this.stage.clientWidth / 2 - local.x * this.camera.scale;
        this.camera.y = this.stage.clientHeight / 2 - local.y * this.camera.scale; this.transform();
      };
      this.mini.onkeydown = event => {if (event.key === 'Enter') {this.autoFit = true; this.fit();}};
    }

    bindNavigation() {
      this.stage.addEventListener('wheel', event => {
        if (event.target.closest('.graph-inspector')) return;
        event.preventDefault(); const rect = this.stage.getBoundingClientRect();
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.stage.clientHeight : 1);
        this.setZoom(Math.exp(-Math.max(-160, Math.min(160, delta)) * .0015), {x: event.clientX - rect.left, y: event.clientY - rect.top});
      }, {passive: false});
      this.stage.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.target.closest('.graph-inspector, .graph-minimap')) return;
        this.moved = false; this.drag = {x: event.clientX, y: event.clientY, camera: {...this.camera}};
      });
      this.stage.addEventListener('pointermove', event => {
        if (!this.drag) return;
        const dx = event.clientX - this.drag.x, dy = event.clientY - this.drag.y;
        if (Math.hypot(dx, dy) > 4) this.moved = true;
        if (this.moved) {
          if (!this.stage.hasPointerCapture(event.pointerId)) this.stage.setPointerCapture(event.pointerId);
          this.autoFit = false; this.stage.classList.add('is-panning');
          this.camera = {...this.drag.camera, x: this.drag.camera.x + dx, y: this.drag.camera.y + dy}; this.transform();
        }
      });
      const stop = event => {
        this.drag = null; this.stage.classList.remove('is-panning');
        if (this.stage.hasPointerCapture(event.pointerId)) this.stage.releasePointerCapture(event.pointerId);
      };
      this.stage.addEventListener('pointerup', stop); this.stage.addEventListener('pointercancel', stop);
      this.stage.addEventListener('keydown', event => {
        if (event.target.closest('.graph-inspector, .graph-card')) return;
        if (['+', '=', '-'].includes(event.key)) {event.preventDefault(); this.setZoom(event.key === '-' ? 1 / 1.25 : 1.25);}
        if (event.key.toLowerCase() === 'f') {event.preventDefault(); this.autoFit = true; this.fit();}
        const delta = {ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40]}[event.key];
        if (delta) {event.preventDefault(); this.autoFit = false; this.camera.x += delta[0]; this.camera.y += delta[1]; this.transform();}
      });
    }

    highlight(id) {
      const connected = new Set([id]);
      for (const {edge, element} of this.edgeElements) {
        const active = edge.from === id || edge.to === id;
        element.classList.toggle('highlighted', active); element.classList.toggle('muted', Boolean(id) && !active);
        if (active) {connected.add(edge.from); connected.add(edge.to);}
      }
      for (const [key, element] of this.nodeElements) {
        element.classList.toggle('selected', key === id);
        element.classList.toggle('muted', Boolean(id) && !connected.has(key));
      }
    }
    inspect(node) {
      this.selected = node.id; this.highlight(node.id); this.inspector.replaceChildren(); this.inspector.hidden = false;
      const description = this.describe(node), head = element('div', 'graph-inspector-head');
      head.append(element('strong', '', description.title), this.button('×', () => this.closeInspector()));
      head.lastChild.setAttribute('aria-label', '关闭节点详情');
      const id = element('code', 'graph-inspector-id', node.id);
      const summary = element('p', 'graph-inspector-summary', (description.speaker ? description.speaker + '：' : '') + description.body);
      const outputs = element('div', 'graph-inspector-ports');
      for (const [port, target] of Object.entries(node.outputs)) {
        const button = this.button((StoryGraphLayout.PORTS[port] || '继续') + ' → ' + shorten(target, 20), () => this.focusNode(target));
        outputs.append(button);
      }
      const raw = element('details', 'graph-raw'); raw.append(element('summary', '', '原始参数'), element('pre', '', JSON.stringify(node.params, null, 2)));
      this.inspector.append(head, id, summary, outputs, raw);
    }
    focusNode(id) {
      const positioned = this.layout.nodes.find(n => n.node.id === id); if (!positioned) return;
      this.autoFit = false; this.camera.scale = Math.max(.75, this.camera.scale);
      this.camera.x = (this.stage.clientWidth - Math.min(270, this.stage.clientWidth / 2)) / 2 - positioned.x * this.camera.scale;
      this.camera.y = this.stage.clientHeight / 2 - positioned.y * this.camera.scale;
      this.transform(); this.inspect(positioned.node);
    }
    closeInspector() {this.selected = null; this.inspector.hidden = true; if (this.nodeElements) this.highlight(null);}
    expand(value) {
      const panel = this.host.closest('.detail');
      this.expanded = value; panel.classList.toggle('graph-expanded', value);
      if (value) {
        panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', '剧情节点图');
      } else {
        panel.removeAttribute('role'); panel.removeAttribute('aria-modal'); panel.removeAttribute('aria-label');
      }
      document.body.classList.toggle('has-expanded-graph', value);
      this.expandButton.textContent = value ? '收起画布' : '展开画布';
      this.autoFit = true; this.fit();
    }
    destroy() {
      this.resize.disconnect(); document.removeEventListener('keydown', this.keyHandler);
      this.expand(false); this.host.classList.remove('story-viewer'); this.host.replaceChildren();
    }
  }
  window.StoryGraphView = StoryGraphView;
})();
