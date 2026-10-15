import { api, readText, LocalStream, initialize } from './app';
declare global { interface Window { storyApp: { api: typeof api; readText: typeof readText; Stream: typeof LocalStream; gameUrl: string } } }
window.storyApp = { api, readText, Stream: LocalStream, gameUrl: import.meta.env.VITE_GAME_URL || '' };
async function script(path: string) { await new Promise<void>((resolve, reject) => { const s = document.createElement('script'); s.src = new URL('ui/' + path, document.baseURI).href; s.onload = () => resolve(); s.onerror = () => reject(Error('界面资源加载失败')); document.body.append(s); }); }
try {
  await initialize();
  for (const path of ['vendor/dagre.min.js', 'graph-layout.js', 'graph-view.js', 'provider-settings.js', 'studio.js', 'studio-layout.js']) await script(path);
} catch (error) { const el = document.getElementById('error'); if (el) el.textContent = error instanceof Error ? error.message : '工作台启动失败'; }
