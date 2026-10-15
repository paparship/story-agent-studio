const StoryProvider = (() => {
  const $ = id => document.getElementById(id);
  const storageKey = 'story-provider-session';
  let config = null;
  try { config = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch {}
  function display() {
    const custom = $('providerMode').value === 'custom';
    $('providerFields').hidden = !custom;
    $('providerFields').disabled = !custom;
    $('providerDefault').hidden = custom;
    for (const id of ['providerUrl', 'providerKey', 'providerModel']) $(id).required = custom;
    $('providerResult').textContent = '';
  }
  function read() {
    if ($('providerMode').value !== 'custom') return null;
    const value = {base_url: $('providerUrl').value.trim().replace(/\/$/, ''), api_key: $('providerKey').value.trim(), model: $('providerModel').value.trim()};
    const url = new URL(value.base_url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('请填写有效的 API Base URL');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('远程 API 请使用 HTTPS');
    if (!value.api_key || !value.model) throw Error('请填写 API Key 和模型名称');
    return value;
  }
  function save(value) {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
    config = value;
  }
  $('providerMode').onchange = display;
  $('providerForm').onsubmit = e => {
    e.preventDefault();
    try { save(read()); $('settingsDialog').close(); }
    catch (error) { $('providerResult').textContent = error.message; }
  };
  $('resetProvider').onclick = () => { save(null); open(); $('providerResult').textContent = '已恢复默认服务'; };
  $('testProvider').onclick = async () => {
    const button = $('testProvider');
    button.disabled = true;
    $('providerResult').textContent = '正在测试连接…';
    try {
      const provider = read();
      const result = await window.storyApp.api('/api/provider/test', {provider});
      $('providerResult').textContent = `连接成功 · ${result.model}`;
    } catch (error) { $('providerResult').textContent = error.message; }
    finally { button.disabled = false; }
  };
  function open() {
    $('providerMode').value = config ? 'custom' : 'default';
    $('providerUrl').value = config?.base_url || '';
    $('providerKey').value = config?.api_key || '';
    $('providerModel').value = config?.model || '';
    display();
  }
  return {open, attach(path, body) {
    const generates = path === '/api/runs' || /\/api\/runs\/[^/]+\/(chat|answer|handoff)$/.test(path);
    return generates && config ? {...body, provider: {...config}} : body;
  }};
})();
