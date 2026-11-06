# 安装教程（dsh-plugin-team-balancer）

> 目标：在 DeepSeek Harness 里装上「多 AI 均衡调度」，让团队队友按权重轮流使用
> DeepSeek / GLM 等供应商，并在左侧边栏面板里随时调整。
>
> 仓库：<https://github.com/hkd-Duo/Dsh-More-Agent-Blance>

## 0. 适用版本与前置条件

| 项目 | 要求 |
|---|---|
| DeepSeek Harness | 桌面版或 Web 版；插件 `0.2.0` 支持 **DSH 0.2.1 及更早**（自动回退）和 **0.2.2-rc.1+**（`agent.model.select()`） |
| 团队能力 | 已启用 Agent Teams bundle（`@deepseek-ai/dsh-experimental-agent-team-profile`，桌面版默认启用） |
| 模型供应商 | 至少一个可用；想「多 AI 均衡」建议配置 **DeepSeek 官方** + **GLM（zai）** 两家 |
| 凭据 | DeepSeek 账号已登录，或已配置 `DEEPSEEK_API_KEY`；GLM 需配置 `ZAI_API_KEY` |
| 网络 | 插件管理器需要能访问 GitHub |

> 判断版本：桌面应用「帮助 / 关于」或安装器版本；本教程以 **0.2.2-rc.1 桌面版**为例。

---

## 1. 方式一：桌面应用图形界面安装（推荐）

桌面应用的 profile 由 Electron 独占管理，**只能用插件管理器安装**（不要用 CLI 改
desktop profile，会提示 “managed exclusively by the Electron application”）。

1. 打开左侧边栏的 **「插件」** 面板（或 **设置 → 插件**）。
2. 进入 **插件管理器 → 添加插件（Add plugin）**。
3. 在输入框里填：

   ```text
   github:hkd-Duo/Dsh-More-Agent-Blance
   ```

4. 点 **安装 / 添加**，等待 pnpm 执行完成；日志里出现 `+ dsh-plugin-team-balancer`
   即安装成功。
5. 关闭对话框，按 **Ctrl+R** 刷新页面。左侧边栏的图标区应出现一个 **天平图标
   （均衡调度）**，位置在内置面板图标之后。
6. 如果没有出现：打开 **设置 → 插件 → 已安装插件**，确认
   `dsh-plugin-team-balancer` 处于 **已启用** 状态；再刷新一次页面。

安装完成后，插件同时提供两个入口：

- 左侧边栏 **天平图标** → 完整配置页（样式、权重池、当前分配）
- **设置 → 插件 → dsh-plugin-team-balancer** → 同一个编辑器的精简版

---

## 2. 方式二：命令行安装（仅限非 Electron 管理的 profile）

适用于自建 Web/TUI profile（例如 `dsh web` 启动的 profile），**不适用于桌面应用的
`desktop` profile**。

```bash
dsh plugin --profile <profile> add github:hkd-Duo/Dsh-More-Agent-Blance
```

- 把 `<profile>` 换成你的 profile 名（自建 Web 通常是 `web`）。
- 安装后重启该 Web/CLI 进程，再刷新浏览器页面。
- 若报 `profile "desktop" is managed exclusively by the Electron application`，
  说明你用的是桌面 profile，请改用方式一。

---

## 3. 方式三：本地开发 / 离线安装

```bash
git clone git@github.com:hkd-Duo/Dsh-More-Agent-Blance.git
dsh plugin --profile <profile> add link:/绝对路径/Dsh-More-Agent-Blance
```

桌面版也可以在插件管理器里选择 **本地目录**，指向 clone 下来的绝对路径。

开发注意：

- 改 `index.js`（Host 半）后需要 **重启应用**（Node 模块只加载一次）；
- 只改 `client.js`（Client 半）时刷新页面即可；
- 本地 link 安装后，插件行来自包内 `cordis.patch.yml`，无需再手改 profile。

---

## 4. 安装后配置供应商（首次必看）

1. 打开 **设置 → 模型（Models）**，确认至少有两家可用模型：
   - `deepseek-official / deepseek-flash`（DeepSeek）
   - `zai / glm-5.3-flash`（GLM，需要 `ZAI_API_KEY`）
2. 点左侧 **天平图标** 打开面板，查看 **路由可用性**：
   - 不可用的路由会标红并显示原因（常见：没配 key、模型 id 不存在）；
   - **只有可用路由参与轮换**，其余自动跳过，不会导致创建队友失败。
3. 默认权重是 `DeepSeek 1 : GLM 1`；可以点「搭配样式」快速套用，也可以自己改
   供应商 / 模型 / 权重（1–100）后 **保存并生效**。

---

## 5. 首次验证（建议照做）

1. 点左侧 **天平图标**，确认面板出现「搭配样式 / 模型池 / 当前分配」。
2. 选 **均衡轮换（1:1）** → **保存并生效**。
3. 让主 Agent 创建两个队友（或自己点 `spawn_teammate`）：
   - 第 1 个队友 → 池中第 1 条路由；
   - 第 2 个队友 → 池中第 2 条路由。
4. 队友运行后看面板的 **「当前分配」** 表：应出现两个不同的 `provider/model`。
5. 想硬核对：打开该队友会话的历史，`request/header` 里的 `config.provider/model`
   就是实际路由（这是最终证据）。

> 主 Agent 和用户自己的普通会话 **不会** 被改路由，这是刻意设计。

---

## 6. 升级

- **插件管理器** 里对已安装的 bundle 点 **更新**（DSH 0.2.2+ 支持第三方插件更新，
  热更新失败会尝试恢复旧版）。
- 或先 **移除**，再按方式一重新添加同一个 GitHub 地址。
- 本地 link 安装：`git pull` 后 **重启应用**。
- 升级后确认插件版本 ≥ **0.2.0**：0.1.0 在 DSH 0.2.2 上会报
  `agent/request proposed … use agent.model.select()` 错误。

---

## 7. 卸载

1. **设置 → 插件 → 已安装插件 → dsh-plugin-team-balancer → 移除**。
2. 左侧天平图标和插件页编辑器会一起消失。
3. 可选清理：删除保存的池配置（不删则下次重装仍沿用你的权重）：

   ```text
   $DSH_HOME/storages/team-balancer/config.json
   ```

   （Windows 默认 `E:\dsh-home\storages\team-balancer\config.json`，以你的
   `DSH_HOME` 为准。）
4. 已存在的队友会保持最后一次请求的模型，不再重新分配。

---

## 8. 常见问题（FAQ）

**Q1：添加插件时报 GitHub 连接失败 / 超时？**
检查网络或代理后重试；仍失败时可以 `git clone` 仓库，再用 **方式三** 本地目录安装。

**Q2：装完侧边栏没有天平图标？**
按 `Ctrl+R` 刷新；再到 **设置 → 插件** 确认 bundle 和行都是启用状态；若插件管理器
显示启用失败，查看 Host 日志/插件详情里的诊断信息。

**Q3：队友报 `agent/request proposed "…" after step preparation fixed "…"; use agent.model.select()`。**
这是插件 0.1.0 与 DSH 0.2.2 的兼容问题，升级到 **0.2.0+** 即可（本仓库已修复）。

**Q4：GLM 路由显示不可用？**
确认 `ZAI_API_KEY` 已配置、模型 id 正确（如 `glm-5.3-flash`），并在 设置 → 模型
里刷新供应商模型目录。

**Q5：为什么有的队友换了模型，有的没换？**
主 Agent 不参与轮换；`includeSubagents` 默认关闭（只调度团队成员）；池中不可用路由
会被跳过。想全部参与可打开「也调度普通子代理」或只保留一条路由。

**Q6：空闲队友在团队面板显示的还是主模型？**
核心 roster 对「未加载」成员会回退显示主 Agent 的模型；该队友**运行时**会显示真实
模型，「当前分配」表和 `request/header` 才是最终依据。

**Q7：想恢复默认配置？**
面板里点 **恢复默认**，或删除 `$DSH_HOME/storages/team-balancer/config.json`。

**Q8：安全影响？**
插件代码运行在本机 Host 进程内，只对被委派出去的子 Agent 改路由；配置 HTTP 路由
仅本机同源可访问；不改主 Agent、不改用户普通会话。

---

## 9. 兼容性表

| 插件版本 | DSH 版本 | 路由方式 |
|---|---|---|
| 0.2.0 | 0.2.2-rc.1 及以上 | `agent.model.select()`（推荐） |
| 0.2.0 | 0.2.1 及更早 | 自动回退 `agent/request` 瀑布 |
| 0.1.0 | 0.2.1 及更早 | `agent/request`；**在 0.2.2 上会失败，请升级** |
