/* Story Agent Studio v0.5 — Unified Agent Chat + Adaptive Side/Main Workbench */
const $ = id => document.getElementById(id);
const labels = {
  queued: '等待生成',
  running: '生成中',
  compiled: '编译通过',
  completed: '完成',
  failed: '需要处理',
  awaiting_input: '待确认细节',
  cancelled: '已取消',
  interrupted: '已中断',
  skipped: '跳过',
};
const gameUrl = window.storyApp.gameUrl;
const gameOrigin = gameUrl ? new URL(gameUrl, location.href).origin : location.origin;

let run = null;
let ws = null;
let chat = { items: [] };
let memoryData = { memories: [] };
let chaptersData = null;
let tracesData = [];

let packageText = '';
let packageData = null;
let viewer = null;
let view = 'graph';
let activeFile = 'story.dsl';
let selection = 0;
let frame = null;
let expectedHash = '';
let stream = null;
let cursor = 0;
let selectedWfStage = null;
let wfStreamExpanded = false;
let agentThinkingStep = null;
let syncTimer = null;

// Track user selections on active clarification card
let clarifySelections = {};

async function api(path, body) { return window.storyApp.api(path, body === undefined ? undefined : StoryProvider.attach(path, body)); }
async function readText(path) { return window.storyApp.readText(path); }

function fail(e) {
  $('error').textContent = e?.message || String(e || '');
}

function clearError() {
  $('error').textContent = '';
}

function stopGame() {
  frame?.remove();
  frame = null;
  expectedHash = '';
  $('gameHost').replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.innerHTML = '<h2>在真实游戏中验证故事</h2><p>每次启动使用新的游戏会话。</p>';
  $('gameHost').append(empty);
  $('gameStatus').textContent = '点击启动试玩，进入新的游戏会话。';
  $('launch').textContent = '启动试玩';
}

function downloadFile(text, name, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function isFileDirty(path) {
  if (!ws || !ws.workspace_files || !ws.saved_files) return false;
  const w = ws.workspace_files[path];
  const s = ws.saved_files[path];
  return w !== undefined && s !== undefined && w !== s;
}

function anyDirtyFiles() {
  if (!ws || !ws.workspace_files || !ws.saved_files) return [];
  return Object.keys(ws.workspace_files).filter(k => ws.workspace_files[k] !== (ws.saved_files[k] ?? ''));
}

function hasPendingProposal() {
  return Boolean(ws && ws.proposed_files && Object.keys(ws.proposed_files).length > 0);
}

function updateLineNumbers(text) {
  const count = Math.max(1, (text || '').split('\n').length);
  const nums = [];
  for (let i = 1; i <= count; i++) nums.push(i);
  $('lineNumbers').textContent = nums.join('\n');
}

function renderDiffHtml(diffText) {
  if (!diffText) return '<span class="diff-line-meta">（无行级差异）</span>';
  return diffText
    .split('\n')
    .map(line => {
      const esc = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (line.startsWith('+') && !line.startsWith('+++')) {
        return `<span class="diff-line-add">${esc}</span>`;
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        return `<span class="diff-line-del">${esc}</span>`;
      }
      return `<span class="diff-line-meta">${esc}</span>`;
    })
    .join('');
}

function setView(next) {
  view = next;
  document.body.classList.toggle('game-mode', next === 'game');
  document.querySelectorAll('.tabs button[data-view]').forEach(b => {
    b.classList.toggle('active', b.dataset.view === next);
  });
  for (const x of ['chapters', 'graph', 'dsl', 'json', 'game']) {
    const el = $(x + 'View');
    if (el) el.hidden = x !== next;
  }
  if (next === 'graph' && packageData) {
    viewer?.destroy();
    viewer = new StoryGraphView($('graph'), { graphs: packageData.graphs }, packageData);
  }
  if (next === 'chapters') {
    renderChaptersOverview();
  }
  if (next === 'json') renderJsonSource();
  if (next === 'dsl') {
    syncEditorDisplay();
  }
}

function renderJsonSource() {
  $('jsonSource').value = packageData ? JSON.stringify(packageData, null, 2) : '';
  $('copyJson').disabled = !packageData;
  $('jsonSourceHint').textContent = !packageData ? '暂无已编译配置 · 只读'
    : anyDirtyFiles().length ? '上次编译结果 · DSL 修改尚未保存编译 · 只读'
    : '已编译配置 · 只读';
}

function emptyGraph() {
  viewer?.destroy();
  viewer = null;
  $('graph').innerHTML =
    '<div class="empty"><h2>从一段故事开始</h2><p>在右侧剧情助手输入故事构想，或打开左侧已有记录。<br>生成完成后，在这里查看人物对话、剧情分支或主线章节总览。</p></div>';
}

/* Render Main Story L1 Chapter Overview DAG */
function renderChaptersOverview() {
  const container = $('chaptersCanvas');
  container.replaceChildren();
  if (!chaptersData || !Array.isArray(chaptersData.chapters)) {
    container.innerHTML =
      '<div class="empty"><h2>等待主线章节规划</h2><p>在右侧输入主线多章节构想后，这里将展示章节安排与故事分支。</p></div>';
    return;
  }

  const headCard = document.createElement('div');
  headCard.className = 'l1-header-card';
  const sharedVars = chaptersData.shared_vars || [];
  headCard.innerHTML = `
    <div class="l1-header-top">
      <h2>《${escapeHtml(String(chaptersData.title || '主线剧情'))}》· 章节规划</h2>
      <span class="badge">共 ${chaptersData.chapters.length} 个章节模块</span>
    </div>
    <div class="muted" style="font-size:12px">${escapeHtml(String(chaptersData.summary || ''))}</div>
    <details class="shared-vars-details" ${sharedVars.length ? "" : "hidden"}><summary>共享变量 · ${sharedVars.length}</summary><div class="shared-vars-list">
      ${sharedVars
        .map(
          v => `
        <div class="shared-var-pill">
          <span>跨章变量</span>
          <code>${escapeHtml(String(v.name))}</code>
          <span class="muted">默认值: ${escapeHtml(String(v.default))} · ${escapeHtml(String(v.desc || ''))}</span>
        </div>`
        )
        .join('')}
    </div></details>
  `;
  container.append(headCard);

  const flow = document.createElement('div');
  flow.className = 'l1-dag-flow';

  const chs = chaptersData.chapters;
  const ch01 = chs.find(c => c.id === 'ch01') || chs[0];
  const branches = chs.filter(c => c.id !== ch01?.id && (c.next || []).length > 0);
  const finals = chs.filter(c => c.id !== ch01?.id && (!c.next || c.next.length === 0));

  const buildCard = ch => {
    const card = document.createElement('div');
    card.className = 'chapter-card';
    card.dataset.chapterId = ch.id;
    const reads = (ch.reads_vars || []).map(v => `<span class="ch-tag">读取: ${escapeHtml(String(v))}</span>`).join('');
    const writes = (ch.writes_vars || []).map(v => `<span class="ch-tag">写入: ${escapeHtml(String(v))}</span>`).join('');
    const fileHasProp = ws?.proposed_files?.[ch.file];
    const fileDirty = isFileDirty(ch.file);
    const statusLabel = fileHasProp
      ? '● 待确认修改'
      : fileDirty
      ? '● 未保存编辑'
      : '单章可预览';
    card.innerHTML = `
      <div class="chapter-card-head">
        <span class="chapter-order">${escapeHtml(String(ch.order || ch.id))}</span>
        <span class="chapter-status">${statusLabel}</span>
      </div>
      <h3>${escapeHtml(String(ch.title))}</h3>
      <p>${escapeHtml(String(ch.summary || ''))}</p>
      <div class="chapter-meta-tags">
        <span class="ch-tag">${escapeHtml(String(ch.file))}</span>
        ${reads}${writes}
      </div>
      <div class="chapter-card-foot">
        <span class="muted">规划条件：${escapeHtml(String(ch.unlock_condition || '自动'))}</span>
        <span>编辑章节 →</span>
      </div>
    `;
    card.onclick = () => drillDownChapter(ch.id);
    return card;
  };

  for (const ch of chs) {
    flow.append(buildCard(ch));
    const links = document.createElement('div');
    links.className='l1-arrow';
    links.textContent=(ch.next||[]).map(n=>`${n.label} → ${chs.find(x=>x.id===n.target)?.title||n.target}`).join(' ｜ ') || '章节终点';
    flow.append(links);
  }

  container.append(flow);
}

async function drillDownChapter(chapterId) {
  if (!run) return;
  const previousChapter = ws?.active_chapter;
  const chapterView = previousChapter ? view : 'graph';
  try {
    await api(`/api/runs/${run.id}/workspace/chapter`, { chapter_id: chapterId });
    await refreshWorkspaceState(run.id, false);
    if (chapterId) {
      activeFile = `chapters/${chapterId}.dsl`;
      await loadCompiledCandidate(selection);
      if (chapterId !== previousChapter) stopGame();
      setView(chapterView);
    } else {
      setView('chapters');
    }
    renderTopAndTabs();
  } catch (e) {
    fail(e);
  }
}

/* Sync DSL Editor & Diff Banner */
function populateFileSelector() {
  const sel = $('dslFileSelect');
  sel.replaceChildren();
  const files = Object.keys(ws?.workspace_files || ws?.saved_files || {});
  if (files.length === 0) {
    const opt = document.createElement('option');
    opt.value = 'story.dsl';
    opt.textContent = 'story.dsl';
    sel.append(opt);
    activeFile = 'story.dsl';
    return;
  }
  if (!files.includes(activeFile)) {
    if (ws?.kind === 'main' && ws?.active_chapter && files.includes(`chapters/${ws.active_chapter}.dsl`)) {
      activeFile = `chapters/${ws.active_chapter}.dsl`;
    } else if (files.includes('story.dsl')) {
      activeFile = 'story.dsl';
    } else {
      activeFile = files.find(f => f.endsWith('.dsl')) || files[0];
    }
  }
  for (const f of files) {
    const opt = document.createElement('option');
    opt.value = f;
    const dirtyMark = isFileDirty(f) ? ' ●' : '';
    const propMark = ws?.proposed_files?.[f] ? ' [待确认修改]' : '';
    opt.textContent = f + dirtyMark + propMark;
    opt.selected = f === activeFile;
    sel.append(opt);
  }
}

function syncEditorDisplay() {
  populateFileSelector();
  const propContent = ws?.proposed_files?.[activeFile];
  const workContent = ws?.workspace_files?.[activeFile] ?? ws?.saved_files?.[activeFile] ?? '';
  const displayContent = propContent !== undefined ? propContent : workContent;

  if ($('dslEditor').value !== displayContent) {
    $('dslEditor').value = displayContent;
  }
  updateLineNumbers(displayContent);

  const dirty = isFileDirty(activeFile);
  $('dslDirtyHint').hidden = !dirty;
  $('saveDslBtn').hidden = !dirty;

  // Show Diff banner if there is a pending proposal for activeFile
  const diffInfo = ws?.proposal_meta?.diffs?.[activeFile];
  if (propContent !== undefined && diffInfo) {
    $('dslDiffBanner').hidden = false;
    $('dslDiffSummary').textContent = `待确认 Agent 修改：${activeFile} (+${diffInfo.added} / -${diffInfo.removed} 行) · 编译校验已通过`;
    $('dslDiffContent').innerHTML = renderDiffHtml(diffInfo.diff_text);
  } else {
    $('dslDiffBanner').hidden = true;
  }
}

/* Render Top Bar, Breadcrumb, Dirty/Proposal Bars & Navigation Tabs */
function renderTopAndTabs() {
  const kind = ws?.kind || run?.kind || 'side';
  const isMain = kind === 'main';
  const activeCh = ws?.active_chapter || null;

  const chapter = isMain && activeCh ? chaptersData?.chapters?.find(ch => ch.id === activeCh) : null;
  const kindTag = $('storyKindTag');
  kindTag.textContent = chapter ? '章节' : isMain ? '主线' : '支线';
  kindTag.className = 'kind-tag ' + (isMain ? 'main' : 'side');

  $('title').textContent = chapter?.title || run?.label || '让故事在游戏里发生';
  $('title').title = chapter ? [chapter.summary, chapter.file].filter(Boolean).join('\n') : run?.summary || '';
  $('status').textContent = labels[run?.status] || '就绪';

  // Main Story L2 Breadcrumb
  if (isMain && activeCh && chaptersData?.chapters) {
    $('l2Breadcrumb').hidden = false;
    $('backToL1Btn').textContent = `← ${run?.label || '主线总览'}`;
    $('backToL1Btn').title = '返回章节总览';
    const qSel = $('chapterQuickSelect');
    qSel.title = chapter?.file || '切换章节';
    qSel.replaceChildren();
    for (const ch of chaptersData.chapters) {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = ch.title;
      opt.selected = ch.id === activeCh;
      qSel.append(opt);
    }
  } else {
    $('l2Breadcrumb').hidden = true;
  }

  // Tabs visibility for Side vs Main L1 vs Main L2
  renderJsonSource();
  $('tabJson').hidden = isMain && !activeCh;
  $('tabChapters').hidden = !isMain;
  if (isMain && !activeCh) {
    $('tabGraph').hidden = true;
    $('tabGame').hidden = true;
    if (view === 'graph' || view === 'game' || view === 'json') {
      setView('chapters');
    }
  } else {
    $('tabGraph').hidden = false;
    $('tabGame').hidden = false;
    if (view === 'chapters' && !isMain) {
      setView('graph');
    }
  }

  // Dirty Bar vs Proposal Bar vs Saved Version Indicator
  const dirtyList = anyDirtyFiles();
  const hasProp = hasPendingProposal();

  $('dirtyBar').hidden = dirtyList.length === 0 || hasProp;
  $('proposalBar').hidden = !hasProp;

  if (hasProp) {
    const diffs = ws?.proposal_meta?.diffs || {};
    const firstDiff = Object.values(diffs)[0];
    $('proposalBarText').textContent = firstDiff
      ? `待确认修改：${firstDiff.path} (+${firstDiff.added} / -${firstDiff.removed} 行)`
      : ws?.proposal_meta?.summary || '待确认 Agent 修改';
  }

  const vNum = ws?.version_num || run?.version_num || 1;
  const hasSaved = ws && Object.keys(ws.saved_files || {}).length > 0;
  $('saved').textContent = hasSaved ? `已保存 · v${vNum}` : '本地草稿';

  // Version dropdown
  const vSel = $('versionSelect');
  const versions = ws?.versions || [];
  if (versions.length > 0) {
    vSel.hidden = false;
    vSel.replaceChildren();
    for (const v of [...versions].reverse()) {
      const opt = document.createElement('option');
      opt.value = v.version;
      opt.textContent = v.label || `v${v.version}`;
      opt.selected = v.version === vNum;
      vSel.append(opt);
    }
  } else {
    vSel.hidden = true;
  }

  // Memory count badge in header
  const memCount = memoryData?.memories?.length || 0;
  $('memCountBadge').textContent = String(memCount);

  const busy = run && ['running', 'queued'].includes(run.status);
  $('cancelRunBtn').hidden = !busy;
  $('sendChatBtn').disabled = !!busy;
  $('agentRunStatus').hidden = !busy;
  $('agentRunStatus').textContent = busy
    ? agentThinkingStep || '正在生成…'
    : labels[run?.status] || '就绪';

  $('download').disabled = !packageData;
  $('launch').disabled = !packageData;
  $('report').hidden = !run?.webgl_playtest;
  $('report').href = run?.webgl_playtest ? '/docs/' + run.webgl_playtest.report : '#';
}

/* Render Unified Right Agent Chat & Interactive Cards */
function renderChatStream() {
  const box = $('chatStream');
  box.replaceChildren();

  const items = chat?.items || [];
  if (!run || items.length === 0) {
    const welcome = document.createElement('div');
    welcome.className = 'chat-welcome';
    welcome.innerHTML = `
      <h3>👋 欢迎使用剧情助手 (Story Agent)</h3>
      <div>直接输入你的故事想法，或点击下方快捷样例立即开始创作：</div>
      <div class="starter-chips">
        <button class="starter-chip" data-kind="side" data-prompt="我想做一个新手村的支线任务：工头老刘想让人捎个口信给在矿道口等他的小陈，告诉他今晚加固木梁。玩家如果索要跑腿费，老刘就不太高兴但还是会给点辛苦费；如果痛快答应，小陈会额外送把旧矿镐。">
          <b>[支线样例] 替工头老刘捎口信</b>
          一次捎信，两种选择与不同回报
        </button>
        <button class="starter-chip" data-kind="main" data-prompt="我要规划一条三章的主线剧情《前哨异变》：第一章《镇口听闻》在镇口女巫处调查前哨失联原因，决定是否带走遗迹奶酪作为信物（记录布尔变量 has_cheese_token）；第二章分为两条分支：分支 A《森林借道》和分支 B《正门强闯》；第三章《前哨重逢》汇聚两条分支，在前哨女巫处迎来最终对质。先帮我生成主线章节总览结构。">
          <b>[主线样例] 前哨异变</b>
          规划章节分支，生成各章初稿
        </button>
      </div>
    `;
    welcome.querySelectorAll('.starter-chip').forEach(btn => {
      btn.onclick = () => {
        $('chatInput').value = btn.dataset.prompt;
        sendChatMessage(btn.dataset.kind);
      };
    });
    box.append(welcome);
    return;
  }

  for (const item of items) {
    if (item.role === 'user') {
      const el = document.createElement('div');
      el.className = 'chat-user';
      el.textContent = item.text;
      box.append(el);
    } else if (item.role === 'workflow') {
      box.append(buildWorkflowCard(item));
    } else if (item.role === 'clarification') {
      box.append(buildClarificationCard(item));
    } else if (item.role === 'conflict') {
      box.append(buildConflictCard(item));
    } else if (item.role === 'handoff') {
      box.append(buildHandoffCard(item));
    } else if (item.role === 'assistant') {
      box.append(buildAssistantCard(item));
    }
  }

  box.scrollTop = box.scrollHeight;
}

/* 1. 3-Column Workflow Progress + Streaming Sliding Window Card */
function buildWorkflowCard(item) {
  const card = document.createElement('div');
  card.className = 'wf-card';

  const stages = (run?.stages || []).slice(item.stage_start || 0, item.stage_end);
  const isMain = item.workflow_type === 'main';
  const stepDefs = isMain
    ? [
        { key: 'understand', label: '1. 拆解章节' },
        { key: 'generate', label: '2. 生成章节' },
        { key: 'compile', label: '3. 编译校验' },
      ]
    : [
        { key: 'understand', label: '1. 理解故事' },
        { key: 'generate', label: '2. 生成 DSL' },
        { key: 'compile', label: '3. 编译校验' },
      ];

  const findStage = prefix => {
    const matches = stages.filter(s => s.id && (s.id.startsWith(prefix) || (isMain && prefix==='understand' && s.id.startsWith('main_plan_')) || (isMain && prefix==='generate' && /^main_\d+_/.test(s.id))));
    return matches.length ? matches[matches.length - 1] : null;
  };

  const wfRunning = item.status === 'running' && run && ['running', 'queued'].includes(run.status);

  // Header with Title on Left and [取消] on Right
  const head = document.createElement('div');
  head.className = 'wf-head';
  const titleSpan = document.createElement('div');
  titleSpan.className = 'wf-title';
  titleSpan.textContent = item.title || '剧情生成工作流';
  head.append(titleSpan);

  if (wfRunning) {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'wf-cancel-btn';
    cancelBtn.textContent = '取消';
    cancelBtn.onclick = () => cancelCurrentRun();
    head.append(cancelBtn);
  } else {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = labels[item.status] || labels[run?.status] || '完成';
    head.append(badge);
  }
  card.append(head);

  // 3-Equal-Column Step Grid
  const grid = document.createElement('div');
  grid.className = 'wf-steps-grid';

  let activeStageObj = null;
  for (let i = 0; i < stepDefs.length; i++) {
    const def = stepDefs[i];
    const st = findStage(def.key);
    const cell = document.createElement('button');
    let stStatus = st?.status || (wfRunning && stages.length === 0 && i === 0 ? 'running' : 'pending');
    if (item.status === 'compiled' && def.key === 'compile') stStatus = 'completed';
    if (stStatus === 'compiled') stStatus = 'completed';

    cell.className = `wf-step-cell ${stStatus}` + (selectedWfStage === def.key ? ' active-view' : '');

    if (stStatus === 'running' && wfRunning) {
      const spin = document.createElement('span');
      spin.className = 'spinner';
      cell.append(spin);
      activeStageObj = st;
    } else {
      const icon = document.createElement('span');
      icon.className = 'step-icon';
      icon.textContent = stStatus === 'completed' ? '✓' : stStatus === 'failed' ? '!' : '·';
      cell.append(icon);
    }

    const lbl = document.createElement('span');
    lbl.textContent = def.label;
    cell.append(lbl);

    cell.onclick = () => {
      if (selectedWfStage === def.key && wfStreamExpanded) {
        wfStreamExpanded = false;
        selectedWfStage = null;
      } else {
        selectedWfStage = def.key;
        wfStreamExpanded = true;
      }
      renderChatStream();
    };
    grid.append(cell);
  }
  card.append(grid);

  // Determine whether streaming sliding window should show
  const inspectedStage =
    (selectedWfStage ? findStage(selectedWfStage) : activeStageObj || stages[stages.length - 1]) ||
    (wfRunning ? { id: 'understand', label: stepDefs[0].label, status: 'running', output: '' } : null);
  const showWindow = wfRunning || wfStreamExpanded;

  if (showWindow && inspectedStage) {
    const win = document.createElement('div');
    win.className = 'wf-stream-window';
    const wHead = document.createElement('div');
    wHead.className = 'wf-stream-head';
    wHead.innerHTML = `<span>实时输出 · ${inspectedStage.label || inspectedStage.id}</span><span>${
      wfRunning ? '流式生成中…' : '点击阶段可收起'
    }</span>`;
    const pre = document.createElement('pre');
    pre.className = 'wf-stream-pre';
    pre.textContent = inspectedStage.output || '正在连接模型并流式拆解剧情，请稍候…';
    win.append(wHead, pre);
    card.append(win);
    setTimeout(() => {
      pre.scrollTop = pre.scrollHeight;
    }, 0);
  } else if (item.summary) {
    const foot = document.createElement('div');
    foot.className = 'wf-foot-summary';
    const iconPrefix = item.status === 'failed' ? '⚠️ ' : '✓ ';
    foot.textContent = `${iconPrefix}${item.summary}（点击上方步骤可展开查看详情）`;
    card.append(foot);
  }

  return card;
}

/* 2. Structured Multiple-Choice Clarification Form Card */
function buildClarificationCard(item) {
  if (item.resolved) {
    const done = document.createElement('div');
    done.className = 'clarify-resolved';
    done.textContent = `✓ 已确认创作细节：${item.selected_summary || '已采用确认项'}`;
    return done;
  }

  const card = document.createElement('div');
  card.className = 'clarify-card';
  card.innerHTML = `
    <div class="clarify-head">
      <strong>📋 有几处剧情与资源细节请确认</strong>
      <span class="badge">待确认</span>
    </div>
  `;

  const questions = item.questions || [];
  questions.forEach((q, qIdx) => {
    const qId = q.id || `q_${qIdx + 1}`;
    if (!clarifySelections[qId]) {
      clarifySelections[qId] = { selected_index: 0, custom_text: '' };
    }
    const curSel = clarifySelections[qId];

    const qBlock = document.createElement('div');
    qBlock.className = 'clarify-q-block';

    const qTitle = document.createElement('div');
    qTitle.className = 'clarify-q-title';
    qTitle.textContent = `${qIdx + 1}. ${q.question}`;
    qBlock.append(qTitle);

    const optsBox = document.createElement('div');
    optsBox.className = 'clarify-options';

    (q.options || []).forEach((optText, oIdx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'clarify-opt-btn' + (curSel.selected_index === oIdx ? ' selected' : '');
      btn.innerHTML = `<span>${curSel.selected_index === oIdx ? '●' : '○'}</span><span>${escapeHtml(optText)}</span>`;
      btn.onclick = () => {
        clarifySelections[qId].selected_index = oIdx;
        renderChatStream();
      };
      optsBox.append(btn);
    });
    qBlock.append(optsBox);

    const customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.className = 'clarify-custom-input';
    customInput.placeholder = q.options?.length ? '其他自定义调整说明（可选）…' : '填写回答…';
    customInput.value = curSel.custom_text || '';
    customInput.oninput = e => {
      clarifySelections[qId].custom_text = e.target.value;
    };
    qBlock.append(customInput);
    card.append(qBlock);
  });

  const actions = document.createElement('div');
  actions.className = 'clarify-actions';

  const submitBtn = document.createElement('button');
  submitBtn.className = 'primary';
  submitBtn.textContent = '确认并继续生成';
  submitBtn.onclick = () => submitClarification(questions, false);

  const recBtn = document.createElement('button');
  recBtn.textContent = '直接采用推荐项';
  recBtn.onclick = () => submitClarification(questions, true);

  actions.append(submitBtn);
  if (questions.every(q => q.options?.length)) actions.append(recBtn);
  card.append(actions);
  return card;
}

async function submitClarification(questions, useRecommendedOnly) {
  if (!run) return;
  const lines = [];
  const shortParts = [];
  questions.forEach((q, idx) => {
    const qId = q.id || `q_${idx + 1}`;
    const sel = clarifySelections[qId] || { selected_index: 0, custom_text: '' };
    const chosenOpt = useRecommendedOnly
      ? (q.options || [])[0]
      : (q.options || [])[sel.selected_index] || (q.options || [])[0] || '';
    if (!chosenOpt && !sel.custom_text?.trim()) { shortParts.push(''); return; }
    const custom = !useRecommendedOnly && sel.custom_text?.trim() ? `（补充：${sel.custom_text.trim()}）` : '';
    lines.push(`问题${idx + 1}（${q.question}）：选择「${chosenOpt}」${custom}`);
    shortParts.push(chosenOpt.replace(/（推荐）$/, '') + custom);
  });
  if (shortParts.some(s => !s)) { fail(Error('请填写每个问题的回答')); return; }
  const answersText = lines.join('\n') || '全部采用系统推荐项';
  const summaryText = shortParts.join('；');

  try {
    const ticket = selection;
    await api(`/api/runs/${run.id}/answer`, {
      answers: answersText,
      selected_summary: summaryText,
    });
    await refreshWorkspaceState(run.id, true);
    connectSSE(run.id, ticket);
  } catch (e) {
    fail(e);
  }
}

/* 3. Unsaved Workspace Modification Conflict Card */
function buildConflictCard(item) {
  if (item.resolved) {
    const done = document.createElement('div');
    done.className = 'clarify-resolved';
    done.textContent = `✓ 工作区未保存修改冲突处理：${item.resolution_label || '已处理'}`;
    return done;
  }

  const card = document.createElement('div');
  card.className = 'conflict-card';
  card.innerHTML = `
    <h4>⚠️ 检测到工作区有未保存的手动修改 (${item.dirty_file})</h4>
    <p>您在编辑器中手动修改了 <code>${item.dirty_file}</code> (+${item.added} / -${item.removed} 行) 尚未保存。剧情助手在继续执行修改前，请确认基于哪个版本进行修改：</p>
    <div class="proposal-diff-box">${renderDiffHtml(item.diff_text)}</div>
  `;

  const actions = document.createElement('div');
  actions.className = 'conflict-actions';

  const keepBtn = document.createElement('button');
  keepBtn.className = 'primary';
  keepBtn.textContent = '保留当前工作区修改并继续（推荐）';
  keepBtn.onclick = () => resolveConflict('keep_workspace', item.pending_message);

  const discardBtn = document.createElement('button');
  discardBtn.textContent = '放弃未保存修改，基于已保存版本修改';
  discardBtn.onclick = () => resolveConflict('use_saved', item.pending_message);

  actions.append(keepBtn, discardBtn);
  card.append(actions);
  return card;
}

async function resolveConflict(choice, pendingMessage) {
  if (!run) return;
  try {
    const ticket = selection;
    await api(`/api/runs/${run.id}/chat`, {
      message: pendingMessage || '',
      editor_files: ws?.workspace_files || {},
      active_file: activeFile,
      conflict_resolution: choice,
    });
    await refreshWorkspaceState(run.id, true);
    connectSSE(run.id, ticket);
  } catch (e) {
    fail(e);
  }
}

/* 4. Cross-Story Handoff Confirmation Card */
function buildHandoffCard(item) {
  if (item.resolved) {
    const done = document.createElement('div');
    done.className = 'clarify-resolved';
    done.textContent = `✓ 跨故事请求已处理（${item.resolution === 'create_new' ? '已新建独立故事记录' : '已覆盖当前故事'}）`;
    return done;
  }

  const card = document.createElement('div');
  card.className = 'handoff-card';
  const kindLabel = item.new_kind === 'main' ? '主线' : '支线';
  card.innerHTML = `
    <h4>💡 识别到全新的${kindLabel}故事创作请求</h4>
    <p>当前工作台正绑定在已有故事<strong>「${item.current_title}」</strong>。您输入的<strong>「${item.new_title}」</strong>是一个全新的独立故事，建议为您新建一条独立记录以避免覆盖当前故事成果：</p>
  `;

  const actions = document.createElement('div');
  actions.className = 'handoff-actions';

  const newBtn = document.createElement('button');
  newBtn.className = 'primary';
  newBtn.textContent = `＋ 新建「${item.new_title}」${kindLabel}并跳转（推荐）`;
  newBtn.onclick = () => resolveHandoff('create_new', item);

  const overwriteBtn = document.createElement('button');
  overwriteBtn.textContent = '仍覆盖当前故事并重新生成';
  overwriteBtn.onclick = () => resolveHandoff('overwrite_current', item);

  actions.append(newBtn, overwriteBtn);
  card.append(actions);
  return card;
}

async function resolveHandoff(choice, item) {
  if (!run) return;
  try {
    const res = await api(`/api/runs/${run.id}/handoff`, {
      resolution: choice,
      new_title: item.new_title,
      new_kind: item.new_kind,
      new_story_text: item.new_story_text,
    });
    await listRuns();
    if (res.new_id) {
      await openRun(res.new_id);
    }
  } catch (e) {
    fail(e);
  }
}

/* Safe Lightweight Markdown Renderer for Assistant Replies */
function renderMarkdown(raw) {
  if (!raw) return '';
  const esc = s =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const codeBlocks = [];
  let text = String(raw).replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre class="md-code-block"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  const formatInline = str => {
    const inlineCodes = [];
    let s = str.replace(/`([^`\n]+)`/g, (_, code) => {
      const idx = inlineCodes.length;
      inlineCodes.push(`<code class="md-inline-code">${esc(code)}</code>`);
      return `\x00INLINECODE_${idx}\x00`;
    });
    s = esc(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/\x00INLINECODE_(\d+)\x00/g, (_, i) => inlineCodes[Number(i)]);
    return s;
  };

  const lines = text.split(/\r?\n/);
  const out = [];
  let listType = null;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\x00CODEBLOCK_\d+\x00$/.test(trimmed)) {
      closeList();
      const idx = Number(trimmed.match(/\d+/)[0]);
      out.push(codeBlocks[idx]);
      continue;
    }
    if (!trimmed) {
      closeList();
      continue;
    }
    const hMatch = line.match(/^\s*(#{1,4})\s+(.+)$/);
    if (hMatch) {
      closeList();
      const level = Math.min(4, hMatch[1].length + 1);
      out.push(`<h${level} class="md-heading">${formatInline(hMatch[2])}</h${level}>`);
      continue;
    }
    const ulMatch = line.match(/^\s*[-*•]\s+(.+)$/);
    if (ulMatch) {
      if (listType !== 'ul') {
        closeList();
        listType = 'ul';
        out.push('<ul class="md-list">');
      }
      out.push(`<li>${formatInline(ulMatch[1])}</li>`);
      continue;
    }
    const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) {
      if (listType !== 'ol') {
        closeList();
        listType = 'ol';
        out.push('<ol class="md-list">');
      }
      out.push(`<li>${formatInline(olMatch[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p class="md-p">${formatInline(line)}</p>`);
  }
  closeList();
  return out.join('');
}

/* 5. Assistant Reply Card (Tool Badges + Memory Badge + Compiler Self-Healing + Proposal Diff) */
function buildAssistantCard(item) {
  const card = document.createElement('div');
  card.className = 'chat-assistant';

  if (item.tool_badges && item.tool_badges.length > 0) {
    const tBox = document.createElement('div');
    tBox.className = 'tool-badges';
    item.tool_badges.forEach(tb => {
      const span = document.createElement('span');
      span.className = 'tool-badge';
      span.textContent = `🔧 ${tb}`;
      tBox.append(span);
    });
    card.append(tBox);
  }

  if (item.compile_repairs && item.compile_repairs.length > 0) {
    const rBox = document.createElement('div');
    rBox.className = 'repair-badge';
    rBox.innerHTML = `🛡️ <b>编译器护栏自愈</b>：拦截了 ${item.compile_repairs.length} 次语法问题（${item.compile_repairs
      .map(r => `第 ${r.line} 行: ${r.message}`)
      .join('；')}）并已自动修复通过。`;
    card.append(rBox);
  }

  if (item.memory_saved) {
    const mBox = document.createElement('div');
    mBox.className = 'memory-badge';
    mBox.innerHTML = `🧠 <b>已写入本故事长期记忆</b>：[${item.memory_saved.topic}] ${item.memory_saved.rule}`;
    card.append(mBox);
  }

  const txt = document.createElement('div');
  txt.className = 'chat-assistant-text';
  txt.innerHTML = renderMarkdown(item.text || '');
  card.append(txt);

  if (item.proposal && item.proposal.diffs) {
    const pCard = document.createElement('div');
    pCard.className = 'proposal-card';
    const firstDiff = Object.values(item.proposal.diffs)[0];
    const resolution = item.proposal.resolution;

    pCard.innerHTML = `
      <div class="proposal-head">
        <span>📝 变更预览：${firstDiff?.path || 'story.dsl'} (+${firstDiff?.added || 0} / -${firstDiff?.removed || 0} 行)</span>
        <span>${
          resolution === 'accepted'
            ? `✓ 已接受 (v${item.proposal.version_num || ''})`
            : resolution === 'rejected'
            ? '✕ 已放弃'
            : '✓ 编译校验通过'
        }</span>
      </div>
      <div class="proposal-diff-box">${renderDiffHtml(firstDiff?.diff_text || '')}</div>
    `;

    if (!resolution && hasPendingProposal()) {
      const pActions = document.createElement('div');
      pActions.className = 'proposal-actions';

      const accBtn = document.createElement('button');
      accBtn.className = 'xs-btn accept-btn';
      accBtn.textContent = '✓ 接受修改';
      accBtn.onclick = () => acceptProposal();

      const rejBtn = document.createElement('button');
      rejBtn.className = 'xs-btn reject-btn';
      rejBtn.textContent = '✕ 放弃';
      rejBtn.onclick = () => rejectProposal();

      const viewDslBtn = document.createElement('button');
      viewDslBtn.className = 'xs-btn';
      viewDslBtn.textContent = '在源码视图查看';
      viewDslBtn.onclick = () => {
        if (firstDiff?.path) activeFile = firstDiff.path;
        setView('dsl');
      };

      pActions.append(accBtn, rejBtn, viewDslBtn);
      pCard.append(pActions);
    }
    card.append(pCard);
  }

  return card;
}

async function acceptProposal() {
  if (!run) return;
  try {
    await api(`/api/runs/${run.id}/proposal/accept`, {});
    await refreshWorkspaceState(run.id, false);
    await loadCompiledCandidate(selection);
    await listRuns();
  } catch (e) {
    fail(e);
  }
}

async function rejectProposal() {
  if (!run) return;
  try {
    await api(`/api/runs/${run.id}/proposal/reject`, {});
    await refreshWorkspaceState(run.id, false);
    await loadCompiledCandidate(selection);
    await listRuns();
  } catch (e) {
    fail(e);
  }
}

/* Load Compiled Package & Graph for Center Workbench */
async function loadCompiledCandidate(ticket) {
  if (!run) return;
  const fixed = (ws?.version_num || 1) === 1 ? run.webgl_playtest?.fixed_configuration : null;
  const base = `/artifacts/${run.id}/candidate/`;
  const paths = fixed
    ? ['/docs/' + fixed, '/docs/' + fixed.replace(/\.json$/, '.story')]
    : [base + 'candidate.json', base + 'candidate.story'];
  try {
    const [jsonText, storyText] = await Promise.all(paths.map(readText));
    if (ticket !== selection) return;
    packageData = JSON.parse(jsonText);
    const nextPackageText = jsonText.replace(/\r\n/g, '\n');
    if (frame && packageText && nextPackageText !== packageText) $('gameStatus').textContent = '配置已有更新，请重新开始试玩以加载当前版本。';
    packageText = nextPackageText;
    if (view === 'graph') {
      viewer?.destroy();
      viewer = new StoryGraphView($('graph'), { graphs: packageData.graphs }, packageData);
    }
  } catch {
    // Candidate not yet compiled
  }
  syncEditorDisplay();
  renderTopAndTabs();
}

/* Refresh Full Workspace State from Backend */
async function refreshWorkspaceState(id, reconnectIfActive = true) {
  const ticket = selection;
  const prevStages = run?.stages || [];
  const payload = await api(`/api/runs/${id}/workspace`);
  if (ticket !== selection) return;
  run = payload.run;
  // Preserve any in-memory streaming delta output for currently running stages
  for (const st of run.stages || []) {
    const oldSt = prevStages.find(p => p.id === st.id);
    if (st.status === 'running' && oldSt?.output && (!st.output || oldSt.output.length > st.output.length)) {
      st.output = oldSt.output;
    }
  }
  ws = payload.workspace;
  chat = payload.chat || { items: [] };
  memoryData = payload.memory || { memories: [] };
  chaptersData = payload.chapters || null;
  tracesData = payload.traces || [];

  renderTopAndTabs();
  renderChatStream();
  syncEditorDisplay();
  if (view === 'chapters') {
    renderChaptersOverview();
  }

  if (reconnectIfActive && ['running', 'queued'].includes(run.status)) {
    connectSSE(id, ticket);
  }
}

/* Connect SSE for Real-Time Streaming */
function connectSSE(id, ticket) {
  stream?.close();
  stream = new window.storyApp.Stream(`/api/runs/${id}/events?after=${cursor}`);
  stream.onmessage = async ({ data }) => {
    if (ticket !== selection) return;
    const e = JSON.parse(data);
    if (e.seq <= cursor) return;
    cursor = e.seq;

    if (e.kind === 'story_metadata') {
      run.label = e.title || run.label;
      run.summary = e.summary || run.summary;
      renderTopAndTabs();
      listRuns().catch(fail);
    }
    if (e.kind === 'stage_started') {
      const existing = run.stages.find(s => s.id === e.stage);
      if (existing) {
        existing.status = 'running';
        existing.output = '';
      } else {
        run.stages.push({ id: e.stage, label: e.label, status: 'running', output: '' });
      }
      renderChatStream();
    }
    if (e.kind === 'delta') {
      let s = run.stages.find(st => st.id === e.stage);
      if (!s) {
        s = { id: e.stage, label: e.stage, status: 'running', output: '' };
        run.stages.push(s);
      }
      s.output = (s.output || '') + e.text;
      // Fast DOM update for active streaming pre
      const pre = document.querySelector('.wf-stream-pre');
      if (pre) {
        pre.textContent = s.output;
        pre.scrollTop = pre.scrollHeight;
      } else {
        renderChatStream();
      }
    }
    if (e.kind === 'stage_finished') {
      const s = run.stages.find(st => st.id === e.stage);
      if (s) {
        s.status = e.status || 'completed';
        if (e.output !== undefined) {
          s.output = typeof e.output === 'string' ? e.output : JSON.stringify(e.output, null, 2);
        }
      }
      renderChatStream();
    }
    if (e.kind === 'agent_step') {
      agentThinkingStep = `思考与工具调用中 (Step ${e.step})…`;
      renderTopAndTabs();
    }
    if (e.kind === 'agent_tool') {
      agentThinkingStep = `正在读取 ${e.path || ''}…`;
      renderTopAndTabs();
    }
    if (
      e.kind === 'chat_updated' ||
      e.kind === 'clarification_requested' ||
      e.kind === 'workspace_conflict_detected' ||
      e.kind === 'new_story_handoff' ||
      e.kind === 'proposal_ready' ||
      e.kind === 'proposal_resolved' ||
      e.kind === 'memory_updated' ||
      e.kind === 'workspace_updated'
    ) {
      await refreshWorkspaceState(id, false);
    }
    if (e.kind === 'run_status') {
      run.status = e.status;
      run.error = e.error;
      agentThinkingStep = null;
      if (e.error && e.status === 'failed') fail(Error(e.error));
      await refreshWorkspaceState(id, false);
      if (['compiled', 'failed', 'cancelled', 'interrupted', 'awaiting_input'].includes(run.status)) {
        stream?.close();
        if (run.status === 'compiled') {
          await loadCompiledCandidate(ticket);
        }
        await listRuns();
      }
    }
  };
  stream.onerror = () => {
    if (ticket === selection) $('connection').textContent = '服务连接就绪';
  };
  stream.onopen = () => {
    $('connection').textContent = '生成服务已连接';
  };
}

/* Sidebar Run List */
async function listRuns() {
  const items = await api('/api/runs');
  const box = $('history');
  box.replaceChildren();
  for (const item of items) {
    const b = document.createElement('button');
    b.className = 'history-item' + (item.id === run?.id ? ' active' : '');
    const kind = item.kind === 'main' ? 'main' : 'side';
    const vNum = item.version_num || 1;
    const dirtyFlag = item.dirty_files && item.dirty_files.length ? ' · ● 未保存' : '';
    const propFlag = item.has_proposal ? ' · ● 待确认修改' : '';
    b.innerHTML = `
      <div class="history-item-top">
        <span class="kind-tag ${kind}">${kind === 'main' ? '主线' : '支线'}</span>
        <b>${escapeHtml(item.label || '未命名故事')}</b>
      </div>
      <small>v${vNum} · ${escapeHtml(labels[item.status] || item.status)}${dirtyFlag}${propFlag}</small>
    `;
    b.onclick = () => openRun(item.id).catch(fail);
    box.append(b);
  }
  return items;
}

/* Open an Existing Story Run */
async function openRun(id) {
  const ticket = ++selection;
  clearError();
  stream?.close();
  stopGame();
  packageData = null;
  packageText = '';
  selectedWfStage = null;
  wfStreamExpanded = false;
  clarifySelections = {};
  emptyGraph();

  const payload = await api(`/api/runs/${id}/workspace`);
  if (ticket !== selection) return;

  run = payload.run;
  ws = payload.workspace;
  chat = payload.chat || { items: [] };
  memoryData = payload.memory || { memories: [] };
  chaptersData = payload.chapters || null;
  tracesData = payload.traces || [];
  cursor = run.cursor || 0;
  location.hash = id;

  // Choose initial view based on story kind & L1/L2 state
  if (ws.kind === 'main' && !ws.active_chapter) {
    view = 'chapters';
  } else if (view === 'chapters' && ws.kind !== 'main') {
    view = 'graph';
  }

  renderTopAndTabs();
  renderChatStream();
  setView(view);

  // Connect SSE immediately before slower secondary fetches so early streaming deltas are never delayed
  if (['running', 'queued'].includes(run.status)) {
    connectSSE(id, ticket);
  }

  await listRuns();
  if (ticket !== selection) return;

  if (run.status === 'compiled' || Object.keys(ws.saved_files || {}).length > 0) {
    await loadCompiledCandidate(ticket);
  }
}

/* Reset to New Empty Story State */
function startNewStoryDraft() {
  ++selection;
  clearError();
  stream?.close();
  stopGame();
  run = null;
  ws = null;
  chat = { items: [] };
  memoryData = { memories: [] };
  chaptersData = null;
  tracesData = [];
  packageData = null;
  packageText = '';
  activeFile = 'story.dsl';
  selectedWfStage = null;
  wfStreamExpanded = false;
  clarifySelections = {};
  history.replaceState(null, '', location.pathname);
  emptyGraph();
  $('dslEditor').value = '';
  updateLineNumbers('');
  setView('graph');
  renderTopAndTabs();
  renderChatStream();
  listRuns().catch(fail);
  $('chatInput').focus();
}

/* Clear Current Chat & Context State (/clear) */
async function clearCurrentContext() {
  clearError();
  selectedWfStage = null;
  wfStreamExpanded = false;
  clarifySelections = {};
  agentThinkingStep = null;
  if (!run) {
    startNewStoryDraft();
    return;
  }
  try {
    stream?.close();
    await api(`/api/runs/${run.id}/clear`, {});
    await refreshWorkspaceState(run.id, false);
    await listRuns();
  } catch (e) {
    fail(e);
  }
}

/* Send Message from Unified Agent Composer */
async function sendChatMessage(forcedKind = null) {
  const text = $('chatInput').value.trim();
  if (!text) {
    $('chatInput').focus();
    return;
  }
  clearError();
  $('chatInput').value = '';

  if (['/clear', '/reset', '清空上下文', '/清理'].includes(text.toLowerCase())) {
    await clearCurrentContext();
    return;
  }

  try {
    if (!run) {
      // Auto-infer kind from text or forcedKind
      const inferredKind =
        forcedKind || (/(主线剧情|主线章节|章节总览|三章的主线|多章节)/.test(text) ? 'main' : 'side');
      const created = await api('/api/runs', {
        mode: 'studio',
        kind: inferredKind,
        label: inferredKind === 'main' ? '新建主线故事' : '新建支线故事',
        message: text,
        auto_start: true,
      });
      await openRun(created.id);
    } else {
      const ticket = selection;
      await api(`/api/runs/${run.id}/chat`, {
        message: text,
        editor_files: ws?.workspace_files || {},
        active_file: activeFile,
      });
      await refreshWorkspaceState(run.id, true);
      connectSSE(run.id, ticket);
    }
  } catch (e) {
    fail(e);
  }
}

async function cancelCurrentRun() {
  if (!run) return;
  try {
    await api(`/api/runs/${run.id}/cancel`, {});
    await refreshWorkspaceState(run.id, false);
    await listRuns();
  } catch (e) {
    fail(e);
  }
}

async function saveManualEdits() {
  if (!run || !ws) return;
  clearError();
  const content = $('dslEditor').value;
  ws.workspace_files[activeFile] = content;
  try {
    await api(`/api/runs/${run.id}/workspace/save`, {
      path: activeFile,
      content,
    });
    await refreshWorkspaceState(run.id, false);
    await loadCompiledCandidate(selection);
    await listRuns();
  } catch (e) {
    fail(e);
  }
}

async function discardManualEdits() {
  if (!run || !ws) return;
  clearError();
  try {
    await api(`/api/runs/${run.id}/workspace/discard`, {
      path: activeFile,
    });
    await refreshWorkspaceState(run.id, false);
    syncEditorDisplay();
    await listRuns();
  } catch (e) {
    fail(e);
  }
}

/* Render Story-Bound Editable Memory Modal */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMemoryModalContent() {
  const boundBar = $('memoryStoryBoundBar');
  const memBox = $('memoryListBox');
  const addBtn = $('addMemoryBtn');
  memBox.replaceChildren();

  if (!run) {
    boundBar.innerHTML = '<span>⚠️ 当前未选中任何故事。<b>记忆绑定在具体故事上（非全局）</b>，请先在左侧选择或新建一个故事。</span>';
    addBtn.disabled = true;
    memBox.innerHTML = '<div class="muted">请先选择或新建一个故事后再查看或编辑其专属记忆。</div>';
    return;
  }

  addBtn.disabled = false;
  const storyTitle = run.title || run.label || '未命名故事';
  const mems = memoryData?.memories || [];
  $('memCountBadge').textContent = String(mems.length);

  boundBar.innerHTML = `
    <div>📌 绑定故事：<b>${escapeHtml(storyTitle)}</b> <span class="muted">（仅对该故事生效，不污染其他故事）</span></div>
    <div><span class="session-id-pill">会话 ID: ${escapeHtml(run.id)}</span> · 已存 <b>${mems.length}</b> / ${memoryData?.max_items || 8} 条</div>
  `;

  if (mems.length === 0) {
    memBox.innerHTML = '<div class="muted">当前故事尚无长期记忆条目。可在上方手动添加，或在对话中告诉剧情助手“记住…”。</div>';
    return;
  }

  mems.forEach(m => {
    const card = document.createElement('div');
    card.className = 'memory-card';

    const top = document.createElement('div');
    top.className = 'memory-card-top';
    top.innerHTML = `
      <div>
        <span class="badge">${escapeHtml(m.trigger || 'explicit_user_rule')}</span>
        <span class="muted">最近激活: Turn ${m.last_active_turn ?? 1} · ID: ${escapeHtml(m.id || '')}</span>
      </div>
    `;

    const actWrap = document.createElement('div');
    actWrap.style.display = 'flex';
    actWrap.style.gap = '6px';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'xs-btn primary';
    saveBtn.textContent = '保存修改';

    const delBtn = document.createElement('button');
    delBtn.className = 'xs-btn reject-btn';
    delBtn.textContent = '删除';

    actWrap.append(saveBtn, delBtn);
    top.append(actWrap);
    card.append(top);

    const makeRow = (labelTxt, val, placeholder) => {
      const row = document.createElement('div');
      row.className = 'memory-edit-row';
      const lbl = document.createElement('span');
      lbl.className = 'memory-edit-label';
      lbl.textContent = labelTxt;
      const inp = document.createElement('input');
      inp.className = 'mem-input';
      inp.value = val || '';
      inp.placeholder = placeholder || '';
      row.append(lbl, inp);
      card.append(row);
      return inp;
    };

    const inpTopic = makeRow('主题分类 (topic)', m.topic || '', '如：角色台词与设定规范');
    const inpRule = makeRow('普适规则 (rule)', m.rule || '', '必填：长期生效的规则描述');
    const inpEntities = makeRow('关联实体 (scope_entities)', (m.scope_entities || []).join(', '), '逗号分隔，留空代表当前故事全局');
    const inpEvent = makeRow('触发事件 (event)', m.event || '', '触发该记忆的对话背景');
    const inpCause = makeRow('原因说明 (error_cause)', m.error_cause || '', '错误根因或偏好说明');

    saveBtn.onclick = async () => {
      try {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中…';
        const res = await api(`/api/runs/${run.id}/memory`, {
          action: 'update',
          id: m.id,
          topic: inpTopic.value.trim() || '通用规则',
          rule: inpRule.value.trim(),
          scope_entities: inpEntities.value,
          event: inpEvent.value.trim(),
          error_cause: inpCause.value.trim(),
          trigger: m.trigger || 'explicit_user_rule',
        });
        memoryData = res.memory;
        saveBtn.textContent = '✓ 已保存';
        setTimeout(() => renderMemoryModalContent(), 500);
      } catch (e) {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存修改';
        fail(e);
      }
    };

    delBtn.onclick = async () => {
      try {
        delBtn.disabled = true;
        const res = await api(`/api/runs/${run.id}/memory`, {
          action: 'delete',
          id: m.id,
          topic: m.topic,
        });
        memoryData = res.memory;
        renderMemoryModalContent();
      } catch (e) {
        delBtn.disabled = false;
        fail(e);
      }
    };

    memBox.append(card);
  });
}

async function openMemoryModal() {
  if (run) {
    try {
      memoryData = await api(`/api/runs/${run.id}/memory`);
    } catch (_) {}
  }
  renderMemoryModalContent();
  $('memoryDialog').showModal();
}

async function addNewMemoryItem() {
  if (!run) return;
  const rule = $('newMemRule').value.trim();
  if (!rule) {
    $('newMemRule').focus();
    return;
  }
  const topic = $('newMemTopic').value.trim() || '通用规则';
  const scope_entities = $('newMemEntities').value.trim();
  const event = $('newMemEvent').value.trim() || '用户在故事记忆面板手动添加';
  try {
    $('addMemoryBtn').disabled = true;
    const res = await api(`/api/runs/${run.id}/memory`, {
      action: 'create',
      topic,
      rule,
      scope_entities,
      event,
      error_cause: '无（用户手动配置）',
      trigger: 'explicit_user_rule',
    });
    memoryData = res.memory;
    $('newMemTopic').value = '';
    $('newMemEntities').value = '';
    $('newMemRule').value = '';
    $('newMemEvent').value = '';
    renderMemoryModalContent();
  } catch (e) {
    fail(e);
  } finally {
    $('addMemoryBtn').disabled = false;
  }
}

/* Render Global Agent Traces Modal (across all sessions, recording session ID) */
async function loadAndRenderGlobalTraces(filterRunId = '') {
  const traceBox = $('traceListBox');
  const sel = $('traceSessionFilter');
  const countSpan = $('traceTotalCount');
  traceBox.innerHTML = '<div class="muted">正在加载全局轨迹…</div>';

  try {
    const q = filterRunId ? `?run_id=${encodeURIComponent(filterRunId)}` : '';
    const data = await api(`/api/traces${q}`);
    const traces = data.traces || [];
    const sessions = data.sessions || [];

    // Rebuild session filter options while preserving current selection
    sel.replaceChildren();
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = '全部会话（全局）';
    sel.append(allOpt);

    sessions.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      const kindTag = s.kind === 'main' ? '主线' : '支线';
      opt.textContent = `[${kindTag}] ${s.label} (${s.id}) · ${s.trace_count} 条`;
      if (s.id === filterRunId) opt.selected = true;
      sel.append(opt);
    });

    countSpan.textContent = `共 ${data.total || traces.length} 条轨迹`;
    traceBox.replaceChildren();

    if (traces.length === 0) {
      traceBox.innerHTML = '<div class="muted">暂无匹配的 Agent 交互轨迹记录。</div>';
      return;
    }

    traces.forEach(t => {
      const div = document.createElement('div');
      div.className = 'trace-item';
      const stepsSummary = (t.steps || [])
        .map(
          s =>
            `Step ${s.step} (${s.llm_call?.latency_ms || 0}ms): ` +
            ((s.tool_executions || []).map(te => `${te.tool}[${te.status || 'ok'}]`).join(', ') || '直接回复')
        )
        .join(' → ');
      const timeStr = t.timestamp
        ? new Date(t.timestamp * 1000).toLocaleString('zh-CN', { hour12: false })
        : '';
      const kindLabel = t.story_kind === 'main' ? '主线' : '支线';
      const modFiles = (t.outcome?.modified_files || []).join(', ');

      const head = document.createElement('div');
      head.className = 'trace-item-head';
      head.innerHTML = `
        <div>
          <span class="session-id-pill" title="会话 ID (run_id)">会话 ID: ${escapeHtml(t.run_id || '')}</span>
          <b>[${kindLabel}] ${escapeHtml(t.story_label || '故事')}</b>
          · <b>${escapeHtml(t.turn_id || '')}</b>
          <span class="muted">${escapeHtml(timeStr)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <span class="muted">决策:</span> <span class="badge">${escapeHtml(t.outcome?.user_resolution || 'none')}</span>
          <span class="muted">编译自愈: ${t.outcome?.compiler_repairs || 0}</span>
        </div>
      `;

      if (t.run_id && t.run_id !== run?.id) {
        const jumpBtn = document.createElement('button');
        jumpBtn.className = 'xs-btn';
        jumpBtn.textContent = '切换至该会话';
        jumpBtn.onclick = () => {
          $('traceDialog').close();
          openRun(t.run_id);
        };
        head.lastElementChild.append(jumpBtn);
      }

      const bodyInput = document.createElement('div');
      bodyInput.innerHTML = `<b>用户输入：</b>${escapeHtml(t.user_input || '')}`;

      const bodySteps = document.createElement('div');
      bodySteps.className = 'muted';
      bodySteps.textContent = `${stepsSummary || '执行完成'}${modFiles ? ' · 涉及文件: ' + modFiles : ''}`;

      div.append(head, bodyInput, bodySteps);
      traceBox.append(div);
    });
  } catch (e) {
    traceBox.innerHTML = `<div class="muted">加载轨迹失败：${escapeHtml(e.message || String(e))}</div>`;
  }
}

function openTraceModal() {
  const initialFilter = $('traceSessionFilter').value || '';
  loadAndRenderGlobalTraces(initialFilter);
  $('traceDialog').showModal();
}

/* Event Bindings */
$('newStory').onclick = startNewStoryDraft;
$('refresh').onclick = () => listRuns().catch(fail);
$('sendChatBtn').onclick = () => sendChatMessage();
$('cancelRunBtn').onclick = cancelCurrentRun;
$('clearChatBtn').onclick = clearCurrentContext;

$('chatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

$('btnSaveManual').onclick = saveManualEdits;
$('saveDslBtn').onclick = saveManualEdits;
$('btnDiscardManual').onclick = discardManualEdits;

$('btnAcceptTop').onclick = acceptProposal;
$('btnRejectTop').onclick = rejectProposal;
$('btnAcceptDsl').onclick = acceptProposal;
$('btnRejectDsl').onclick = rejectProposal;

$('backToL1Btn').onclick = () => drillDownChapter(null);
$('chapterQuickSelect').onchange = e => drillDownChapter(e.target.value);

$('dslFileSelect').onchange = e => {
  activeFile = e.target.value;
  syncEditorDisplay();
};

$('dslEditor').addEventListener('input', () => {
  const val = $('dslEditor').value;
  updateLineNumbers(val);
  if (ws && ws.workspace_files) {
    ws.workspace_files[activeFile] = val;
    renderTopAndTabs();
    $('dslDirtyHint').hidden = !isFileDirty(activeFile);
    $('saveDslBtn').hidden = !isFileDirty(activeFile);
    if (run) {
      const editRunId = run.id, editPath = activeFile;
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        api(`/api/runs/${editRunId}/workspace/sync`, { path: editPath, content: val }).catch(fail);
      }, 450);
    }
  }
});

$('dslEditor').addEventListener('scroll', () => {
  $('lineNumbers').scrollTop = $('dslEditor').scrollTop;
});

document.querySelectorAll('.tabs button[data-view]').forEach(b => {
  b.onclick = () => setView(b.dataset.view);
});

$('copyJson').onclick = () => {
  navigator.clipboard.writeText($('jsonSource').value).then(() => {
    $('copyJson').textContent = '已复制';
    setTimeout(() => ($('copyJson').textContent = '复制'), 1500);
  }).catch(fail);
};

$('copyDsl').onclick = () => {
  navigator.clipboard.writeText($('dslEditor').value).then(() => {
    $('copyDsl').textContent = '已复制';
    setTimeout(() => ($('copyDsl').textContent = '复制'), 1500);
  });
};

$('downloadDsl').onclick = () => downloadFile($('dslEditor').value, activeFile.replace(/\//g, '_'));
$('download').onclick = () => downloadFile(packageText, (packageData?.packageId || 'story') + '.json', 'application/json');

$('importFile').onchange = async e => {
  try {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 100000) throw Error('请选择 100 KB 以内的文本。');
    $('chatInput').value = await f.text();
  } catch (err) {
    fail(err);
  } finally {
    e.target.value = '';
  }
};

$('openMemoryBtn').onclick = openMemoryModal;
$('closeMemoryDialog').onclick = () => $('memoryDialog').close();
$('addMemoryBtn').onclick = addNewMemoryItem;

$('inspectTraceBtn').onclick = openTraceModal;
$('closeTraceDialog').onclick = () => $('traceDialog').close();
$('traceSessionFilter').onchange = e => loadAndRenderGlobalTraces(e.target.value);
$('filterCurrentSessionBtn').onclick = () => {
  const curId = run?.id || '';
  $('traceSessionFilter').value = curId;
  loadAndRenderGlobalTraces(curId);
};
$('refreshTracesBtn').onclick = () => loadAndRenderGlobalTraces($('traceSessionFilter').value || '');
$('openSettings').onclick = () => { StoryProvider.open(); $('settingsDialog').showModal(); };
$('closeSettings').onclick = () => $('settingsDialog').close();

$('help').onclick = () => $('helpDialog').showModal();
$('closeHelp').onclick = () => $('helpDialog').close();

/* WebGL Playtest Launcher */
$('launch').onclick = async () => {
  if (!packageData) return;
  if (!gameUrl) { $('gameStatus').textContent = '试玩资源尚未配置，可先导出配置。'; return; }
  stopGame();
  $('gameStatus').textContent = '正在加载游戏，随后选择 New Game…';
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(packageText));
  expectedHash = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  frame = document.createElement('iframe');
  frame.title = '剧情实机试玩';
  const playUrl = new URL(gameUrl, location.href);
  playUrl.searchParams.set('studio', '1');
  playUrl.searchParams.set('session', crypto.randomUUID());
  frame.src = playUrl.href;
  $('gameHost').replaceChildren(frame);
  $('launch').textContent = '重新开始';
};

window.addEventListener('message', e => {
  if (e.origin !== gameOrigin || e.source !== frame?.contentWindow) return;
  const msg = e.data;
  if (msg?.type === 'story-studio:ready') {
    frame.contentWindow.postMessage({ type: 'story-studio:load', text: packageText, hash: expectedHash }, gameOrigin);
  }
  if (msg?.type === 'story-studio:status') $('gameStatus').textContent = msg.text;
  if (msg?.type === 'story-studio:applied') {
    $('gameStatus').textContent =
      msg.hash === expectedHash ? '配置已加载 · ' + msg.revision : '加载结果与当前配置不一致，请重新开始。';
  }
});

/* Initial Boot */
(async () => {
  const health = await api('/api/health');
  $('connection').textContent = health.key_configured ? '生成服务已连接' : '生成服务未配置密钥';
  await listRuns();
  const id = location.hash.slice(1);
  if (id) {
    await openRun(id).catch(() => { location.hash = ''; startNewStoryDraft(); });
  } else {
    startNewStoryDraft();
  }
})().catch(fail);

$('versionSelect').onchange=async()=>{
  const target=Number($('versionSelect').value);
  if(!run || target===ws?.version_num)return;
  if(!confirm(`将 v${target} 恢复为一个新版本，现有历史会保留。是否继续？`)){renderTopAndTabs();return;}
  try{await api(`/api/runs/${run.id}/workspace/restore`,{version:target});await refreshWorkspaceState(run.id);await loadCompiledCandidate(selection);}
  catch(e){alert(e.message||String(e));renderTopAndTabs();}
};
