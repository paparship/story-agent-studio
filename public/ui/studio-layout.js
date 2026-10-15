/* Persistent panel widths; the graph observes its own available size. */
(() => {
  const workspace = document.querySelector('.workspace');
  const key = 'story-studio-panel-widths';
  let preferred = {}, drag = null;
  try { preferred = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
  if (!preferred || typeof preferred !== 'object') preferred = {};
  const narrow = () => innerWidth <= 800;
  const game = () => document.body.classList.contains('game-mode');
  const collapsed = () => document.body.classList.contains('library-collapsed');
  const toggle = document.getElementById('toggleLibrary');
  try { document.body.classList.toggle('library-collapsed', localStorage.getItem('story-studio-library-collapsed') === 'true'); } catch {}
  function syncToggle() {
    toggle.setAttribute('aria-expanded', String(!collapsed()));
    toggle.title = collapsed() ? '展开故事记录' : '收起故事记录';
    toggle.setAttribute('aria-label', toggle.title);
  }
  toggle.onclick = () => {
    document.body.classList.toggle('library-collapsed');
    try { localStorage.setItem('story-studio-library-collapsed', String(collapsed())); } catch {}
    syncToggle(); paint();
  };
  syncToggle();
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const wanted = (side, fallback) => Number.isFinite(preferred[side]) ? preferred[side] : fallback;
  const handles = {};
  function sizes() {
    const width = workspace.clientWidth;
    let left = clamp(wanted('left', game() ? 180 : innerWidth <= 1100 ? 160 : 205), 140, 380);
    if (collapsed()) left = 48;
    let right = game() ? 0 : clamp(wanted('right', innerWidth <= 1100 ? 310 : 395), 240, 600);
    right = Math.min(right, Math.max(240, width - 320 - (collapsed() ? 48 : 140)));
    if (!collapsed()) left = Math.min(left, Math.max(140, width - 320 - right));
    return {left, right, width};
  }
  function paint() {
    if (narrow()) return;
    const s = sizes();
    workspace.style.setProperty('--library-width', s.left + 'px');
    workspace.style.setProperty('--assistant-width', s.right + 'px');
    for (const side of ['left', 'right']) {
      const h = handles[side];
      h.style.left = (side === 'left' ? s.left : s.width - s.right) + 'px';
      h.setAttribute('aria-valuenow', Math.round(s[side]));
      h.setAttribute('aria-valuemin', side === 'left' ? 140 : 240);
      h.setAttribute('aria-valuemax', side === 'left' ? Math.min(380, s.width - 320 - s.right) : Math.min(600, s.width - 320 - s.left));
    }
  }
  function save() { try { localStorage.setItem(key, JSON.stringify(preferred)); } catch {} }
  function resize(side, value) {
    const s = sizes();
    preferred[side] = side === 'left'
      ? clamp(value, 140, Math.min(380, s.width - 320 - s.right))
      : clamp(value, 240, Math.min(600, s.width - 320 - s.left));
    paint();
  }
  function finish() {
    if (!drag) return;
    const {handle, pointerId} = drag;
    drag = null;
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    document.body.classList.remove('resizing-panels');
    save();
  }
  for (const side of ['left', 'right']) {
    const h = document.createElement('div');
    h.className = 'panel-divider divider-' + side;
    h.tabIndex = 0;
    h.setAttribute('role', 'separator');
    h.setAttribute('aria-orientation', 'vertical');
    h.setAttribute('aria-label', side === 'left' ? '调整记录栏宽度' : '调整生成面板宽度');
    h.title = '拖动调整宽度 · 双击恢复默认';
    workspace.append(h); handles[side] = h;
    h.addEventListener('pointerdown', e => {
      if (e.button !== 0 || narrow()) return;
      e.preventDefault(); h.focus();
      drag = {handle:h, pointerId:e.pointerId, side, start:e.clientX, width:sizes()[side]};
      h.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing-panels');
    });
    h.addEventListener('pointermove', e => {
      if (!drag || drag.handle !== h) return;
      resize(side, drag.width + (e.clientX - drag.start) * (side === 'left' ? 1 : -1));
    });
    h.addEventListener('pointerup', finish);
    h.addEventListener('pointercancel', finish);
    h.addEventListener('lostpointercapture', finish);
    h.addEventListener('dblclick', () => { delete preferred[side]; paint(); save(); });
    h.addEventListener('keydown', e => {
      if (!['ArrowLeft','ArrowRight','Home'].includes(e.key)) return;
      e.preventDefault();
      if (e.key === 'Home') { delete preferred[side]; paint(); }
      else resize(side, sizes()[side] + (e.key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? 1 : -1) * (e.shiftKey ? 40 : 10));
      save();
    });
  }
  window.addEventListener('blur', finish);
  new ResizeObserver(() => { if (narrow()) finish(); paint(); }).observe(workspace);
  new MutationObserver(paint).observe(document.body, {attributes:true, attributeFilter:['class']});
  paint();
})();
