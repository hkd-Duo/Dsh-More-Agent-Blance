# dsh-plugin-team-balancer

[English](README.md) · [实现说明](docs/how-it-works.md) · [更新日志](CHANGELOG.md) · [参与贡献](CONTRIBUTING.md) · [GitHub](https://github.com/hkd-Duo/More-Agent-Blance)

> **为 DeepSeek Harness 的团队多 Agent 做「多 AI 均衡调度」。**
> 队友（以及可选的普通子代理）按权重轮流分配给 DeepSeek、GLM 等已挂载的供应商，
> 主 Agent（Lead）保持自己的模型；搭配样式、权重池、当前分配全部在左侧边栏面板里
> 可视化编辑。

- 包名：`dsh-plugin-team-balancer`
- 插件行：`team-balancer`
- Host + Client 双半，零运行时依赖，MIT

---

## 为什么需要它

Agent Teams 默认让所有被委派的子 Agent 继承主 Agent 的模型。已经配好 DeepSeek 和
GLM 的 profile 里，整支队伍仍然只跑一家：一份账单、一个限流、一种故障模式，其他
供应商完全不参与。

本插件把「谁来干活」变成一条可见、可调的策略：一个带权重的「provider/model」池，
按队友创建顺序轮流分配，主 Agent 不参与。

## 功能

- **左侧边栏面板**：点天平图标打开完整编辑器，无需改后台 YAML。
- **搭配样式一键套用**：均衡轮换 1:1、DeepSeek 优先 2:1、GLM 优先 1:2、
  仅 DeepSeek、仅 GLM；套用后还能继续微调权重。
- **自定义模型池**：最多 20 条 provider/model 路由，权重 1–100；Host 当前挂载的
  供应商和模型都能在下拉框里选。
- **当前分配表**：每个队友/子代理实际跑在哪个模型上一目了然。
- **保存立即生效**：不用重启；正在运行的队友保持当前模型，空闲/新队友在下次请求
  时按新权重重新分配。
- **优雅降级**：供应商未挂载、模型不可解析的路由自动跳过并提示，不会让创建队友失败。
- **持久粘性**：队友序号来自 durable Team roster，冷恢复/重启后仍是同一条路由。
- **插件页也有一份**：设置 → 插件 → *dsh-plugin-team-balancer* 页面里是同一个编辑器。

## 安装

### 界面安装

1. 打开 **设置 → 插件 → 插件管理器 → 添加插件**。
2. 填入 GitHub 地址：`github:hkd-Duo/More-Agent-Blance`
3. 确认安装；如果侧边栏图标没有立刻出现，按 `Ctrl+R` 刷新页面即可。

### 命令行安装

```bash
dsh plugin --profile <profile> add github:hkd-Duo/More-Agent-Blance
```

### 本地开发

```bash
dsh plugin --profile <profile> add link:/绝对路径/dsh-plugin-team-balancer
```

包是自包含 bundle：patch 插入 `team-balancer` 行，`dsh.client` 声明提供侧边栏面板与
插件页编辑器，不需要额外安装第二个包。

## 使用

1. 点左侧边栏的**天平图标**（在内置面板之后）。
2. 选一个**搭配样式**，或直接编辑模型池：供应商 / 模型 / 权重、增删行。
3. 按需打开「启用均衡调度」「也调度普通子代理」。
4. 点 **保存并生效**。
5. 照常让主 Agent 创建队友；「当前分配」表会显示每个队友实际跑在哪。

主 Agent 和用户自己的普通会话永远不会被改路由。

## 配置

出厂默认值见 [cordis.patch.yml](cordis.patch.yml)。界面保存的覆盖项存放在：

```text
$DSH_HOME/storages/team-balancer/config.json
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭后子 Agent 恢复继承主模型 |
| `includeSubagents` | `false` | 是否也调度普通 `subagent` / `subagent_fork` |
| `pool[].provider` | — | LLM provider 路由 id，如 `deepseek-official`、`zai` |
| `pool[].model` | — | 该 provider 下的模型 id |
| `pool[].weight` | `1` | 1–100 的整数，参与平滑加权轮转 |
| `pool[].reasoningEffort` | 不设置 | 该路由固定思考档位；不设置时切换供应商会清掉继承的 effort |

分配规则：队友序号 `N`（durable roster 创建顺序）取
`cycle[N % cycleLength]`，`cycle` 由权重经平滑加权轮转生成。例如
`deepseek 2 : glm 1` → `[deepseek, glm, deepseek]`。

Host HTTP 路由（仅本机同源可访问）：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/dsh-team-balancer/state` | GET | 生效配置、可用供应商/模型、路由可用性、当前分配 |
| `/dsh-team-balancer/config` | POST | 校验、持久化并热应用 `{enabled, includeSubagents, pool}` |
| `/dsh-team-balancer/reset` | POST | 删除覆盖项，回到 bundle 默认值 |

## 实现

完整数据流见 [docs/how-it-works.md](docs/how-it-works.md)。简述：

1. `agent/created` 为每个被委派的子 Agent 分配粘性路由，回写 `AgentOptions`，并在
   DSH 0.2.2+ 上通过 `agent.model.select()` 在步前准备阶段固定本步模型。
2. DSH 0.2.2+ 的路由完全由该选择承担；旧内核上仍由 Host 级 `agent/request`
   瀑布监听作为回退来应用同一条路由。
3. 根 Session 跳过；路由用 `ctx.llm.resolveModelInfo` 校验（60 秒缓存），
   `llm/adapters-updated` 时失效重算。

## 开发

没有构建步骤，纯 ESM，只用两个 Node 内置模块。

```bash
npm run check   # 两半的语法检查
npm test        # 假 Cordis 的 Host 测试 + 假 ModuleLoader 的 Client 测试
```

两个测试都能用纯 Node（>= 20）直接跑，无依赖：

- `tools/host-test.mjs`：把真实 Host 半挂到假上下文上，验证分配、请求改写、
  HTTP 保存/重置/校验与持久化。
- `tools/client-test.mjs`：用假模块加载器、React 桩和假上下文执行真实 client 包，
  验证三个界面注册点。

## 兼容性

- 需要挂载了 Agent Teams 实验 bundle
  （`@deepseek-ai/dsh-experimental-agent-team-profile`）的 DSH 桌面/Web profile。
- **DSH 0.2.2+**：路由使用 `agent.model.select()`（新内核在提示词组装前固定本步模型）。
- **DSH ≤ 0.2.1**：插件检测到没有 `agent.model` API 时，自动回退到 `agent/request`
  瀑布改写路由。
- 侧边栏面板依赖 Web UI；无界面的 CLI-only profile 里 Host 半仍会调度，
  HTTP 路由仍可用。

## 已知边界

- **空闲队友的 roster 显示**：核心 roster 对未加载成员回退显示主模型；运行中的队友
  显示真实模型。「当前分配」表和子会话 `request/header` 才是最终依据。
- **不做故障转移**：运行中 provider 失败交给现有 `llm-retry`，本插件不会切到备用路由。
- **fork 子代理**：切换 provider 时历史 replay 元数据会按 Harness 既有行为降级为
  普通文本，不影响继续对话。
- **只对之后的请求生效**：已经在飞的一步请求不会被中途切换。

## License

[MIT](LICENSE) © hkd-Duo
