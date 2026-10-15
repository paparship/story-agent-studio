"""One-time migration of the existing view layer, with local browser service bindings."""
import shutil,re
from pathlib import Path
dest=Path(__file__).resolve().parents[1]; src=dest.parent/'workflow-ui'
ui=dest/'public/ui';ui.mkdir(parents=True,exist_ok=True)
for name in ('studio.css','graph-view.css','graph-layout.js','graph-view.js','studio-layout.js'):
    shutil.copyfile(src/name,ui/name)
(ui/'vendor').mkdir(exist_ok=True)
shutil.copyfile(src/'vendor/dagre.min.js',ui/'vendor/dagre.min.js')
html=(src/'studio.html').read_text(encoding='utf-8')
html=re.sub(r'<script src="[^"]+"></script>','',html)
html=html.replace('href="studio.css"','href="./ui/studio.css"').replace('href="graph-view.css"','href="./ui/graph-view.css"')
html=html.replace('</body>','<script type="module" src="/src/main.ts"></script>\n</body>')
html=html.replace('后端','默认服务').replace('服务端','默认服务')
(dest/'index.html').write_text(html,encoding='utf-8')
js=(src/'studio.js').read_text(encoding='utf-8')
begin=js.index('async function api(');end=js.index('\nfunction fail(',begin)
js=js[:begin]+'''async function api(path, body) { return window.storyApp.api(path, body === undefined ? undefined : StoryProvider.attach(path, body)); }
async function readText(path) { return window.storyApp.readText(path); }
'''+js[end:]
js=js.replace("const gameOrigin = 'http://127.0.0.1:8765';", "const gameUrl = window.storyApp.gameUrl;\nconst gameOrigin = gameUrl ? new URL(gameUrl, location.href).origin : location.origin;")
js=js.replace('new EventSource(', 'new window.storyApp.Stream(')
js=js.replace("frame.src = gameOrigin + '/?studio=1';", "frame.src = new URL(gameUrl, location.href).href + (gameUrl.includes('?') ? '&' : '?') + 'studio=1';")
js=js.replace("if (!packageData) return;\n  stopGame();", "if (!packageData) return;\n  if (!gameUrl) { $('gameStatus').textContent = '试玩资源尚未配置，可先导出配置。'; return; }\n  stopGame();")
js=js.replace("${item.label || '未命名故事'}", "${escapeHtml(item.label || '未命名故事')}")
js=js.replace("${labels[item.status] || item.status}", "${escapeHtml(labels[item.status] || item.status)}")
js=js.replace("await openRun(id);\n  } else", "await openRun(id).catch(() => { location.hash = ''; startNewStoryDraft(); });\n  } else")
js=js.replace("api(`/api/runs/${run.id}/workspace/sync`, { path: activeFile, content: val }).catch(() => {});", "api(`/api/runs/${run.id}/workspace/sync`, { path: activeFile, content: val }).catch(fail);")
# Capture the editor target at input time, so switching chapters cannot redirect a delayed draft save.
js=js.replace("clearTimeout(syncTimer);\n      syncTimer", "const editRunId = run.id, editPath = activeFile;\n      clearTimeout(syncTimer);\n      syncTimer")
js=js.replace("api(`/api/runs/${run.id}/workspace/sync`, { path: activeFile, content: val })", "api(`/api/runs/${editRunId}/workspace/sync`, { path: editPath, content: val })")
# Free-form clarification is required when the model did not provide options.
js=js.replace("const chosenOpt = useRecommendedOnly", "const chosenOpt = useRecommendedOnly")
js=js.replace("|| '采用默认推荐';", "|| '';\n    if (!chosenOpt && !sel.custom_text?.trim()) throw Error('请填写问题的回答');")
js=js.replace("actions.append(submitBtn, recBtn);", "actions.append(submitBtn);\n  if (questions.every(q => q.options?.length)) actions.append(recBtn);")
js=js.replace("self-healing", "repair")
(ui/'studio.js').write_text(js,encoding='utf-8')
p=(src/'provider-settings.js').read_text(encoding='utf-8')
start=p.index("      const response = await fetch('/api/provider/test'");end=p.index("      $('providerResult').textContent",start)
p=p[:start]+"      const result = await window.storyApp.api('/api/provider/test', {provider});\n"+p[end:]
(ui/'provider-settings.js').write_text(p,encoding='utf-8')
