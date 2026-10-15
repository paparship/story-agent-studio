# Story Agent Studio

把故事文本转成可编辑、可编译、可试玩的游戏剧情。

工作台提供故事理解、DSL 生成、编译修正、节点图预览、人工编辑、修改提案和版本记录。核心编译器、工作流与存储运行于浏览器；默认模型服务经 Cloudflare Worker 转发。也可在设置中填写自己的 OpenAI 兼容 API。

## 本地运行

使用 Node.js 22 和 pnpm 11：

```sh
pnpm install
cp .env.example .env.local
pnpm dev
```

`pnpm test` 执行编译器、配置校验、存储、流式输出与工作流测试。`pnpm build` 输出静态站点到 `dist/`。构建不依赖 Python；`scripts/*.py` 仅用于从早期开发项目导入对照测试与资源。

## 使用

1. 新建独立支线，输入已写好的故事。
2. 确认需要补充的内容，等待生成与编译完成。
3. 查看节点图，或在 DSL 页编辑并保存新版本。JSON 页只读。
4. 向剧情助手提出调整，查看差异后采用或放弃提案。
5. 打开试玩并选择 New Game，工作台会加载当前已保存配置。

故事、聊天和版本保存在当前浏览器的 IndexedDB 中，不上传到项目服务器。清除站点数据会删除这些本地记录；重要配置请导出。生成请求会向所选模型服务发送故事与相关配置。

## 结构

- `src/compiler`：DSL 解析、编译、诊断和目标协议校验。
- `src/workflow`：故事理解、生成、修正与调整流程。
- `src/storage`：浏览器持久化、草稿、提案、版本与并发保护。
- `src/llm`：OpenAI 兼容流式客户端。
- `public/ui`：工作台视图与节点图。
- `proxy`：Cloudflare Worker 与 Durable Objects 额度记录。
- `tests`：与原编译器的对照用例和浏览器核心单测。

## 部署

GitHub Actions 构建并发布 GitHub Pages。仓库变量 `VITE_PROXY_URL` 指向代理；`VITE_GAME_URL` 可指向自行部署的游戏页面。

代理配置见 `proxy/wrangler.jsonc`。部署者需设置允许的前端来源，并通过 `wrangler secret put` 设置 `DEEPSEEK_API_KEY` 和随机 `SESSION_SECRET`。密钥不进入前端构建。每个匿名浏览器会话累计可发起 10 次操作，同一次操作中的生成和编译修正共用额度。访客身份由签名令牌和浏览器存储维持，并辅以 IP 会话签发限流；这不等同于登录账号的强身份额度。自行填写 API 的请求直接发送到用户配置的服务，不计入公共服务额度。

## 当前范围

独立支线支持多 NPC、对话、条件分支、任务阶段、物品转移、空间位置和行为编排。主线提供章节规划与逐章编译、编辑和试玩；章节间自动衔接仍需游戏运行层扩展。编译成功表示语法及协议校验通过，不替代实机行为验证。

游戏适配基于 ORK 3 的 3D RPG Playground 教程项目。它是第三方教程示例，并非本仓库的开源游戏。Unity 工程与第三方框架源码不随本仓库分发。资源来源和使用限制见 [第三方说明](THIRD_PARTY_NOTICES.md)。
