# 部署与游戏适配

## 静态前端

运行 `pnpm build`，将 `dist/` 发布到静态托管。仓库内的 GitHub Actions 已配置 GitHub Pages 发布流程，构建前执行单元测试。

环境变量：

| 变量 | 用途 |
| --- | --- |
| `VITE_PROXY_URL` | 默认模型代理地址 |
| `VITE_GAME_URL` | Unity WebGL 试玩页面地址 |

也可直接在工作台「设置」里填写 OpenAI 兼容 API 地址、模型名和 Key。自定义凭据保留在当前浏览器会话。

## 默认模型代理

`proxy/` 使用 Cloudflare Workers 与 Durable Objects。按 `proxy/wrangler.jsonc` 设置账号、允许的前端来源和部署名称，通过 Wrangler Secret 配置 `DEEPSEEK_API_KEY` 与随机的 `SESSION_SECRET`。

公共服务为每个匿名浏览器会话提供 10 次操作额度，一次操作内的生成、校验修正共用额度。签名令牌配合浏览器存储识别会话，IP 限流控制会话签发。额度用尽后，界面提示切换自定义模型服务。

## 游戏适配

当前演示对接 ORK 3 / Makinom 的 3D RPG Playground WebGL 环境。工作台将编译后的配置交给游戏侧适配层加载；试玩页面提供角色选择、附近传送与任务状态观察。

现有发布流程从 `demo-runtime-v1` Release 获取独立打包的游戏运行资源。自行部署时，可配置 `VITE_GAME_URL` 接入自己的试玩页面，或提供相应的 Release 资源。

游戏资源来源与许可证见 [第三方说明](../THIRD_PARTY_NOTICES.md)。
