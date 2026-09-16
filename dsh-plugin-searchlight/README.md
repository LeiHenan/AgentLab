# `@agentlab/dsh-plugin-searchlight` — 探照灯工作法的 DSH 实现

把 `Agent探照灯工作法_从实验到课题_v2` 这份方法论文档，做成 **DeepSeek Harness 里可执行、且无法被绕过的实验框架**。

核心思路：**方法论不靠自觉，靠工具报错。** 文档里的每条硬判据都变成工具的前置条件——模型想跳过噪声底线、想事后补写判据、想把未证伪的假设写成课题，工具会直接拒绝并给出修复路径。

## 这解决了文档的什么痛点

| 文档条目 | 靠人自觉时的问题 | 本插件的强制方式 |
|---|---|---|
| §1.2 噪声底线（重复≥3、效应量≥3×） | 单点观测被当成"反常" | 工具自己算分布与效应量；不足阈值 → 只能记为「噪声待查」，**拒绝进入下一步** |
| §4.3 自证伪四问 | 跳过或口头应付 | 声称"发现"时必须逐条回答四问；任一 false → 降级"待查缺陷" |
| §1.4 占位核查三态 | 直接跳到"没人做过" | 状态为 partial/quantitative 时**强制**填"占据方做了什么 + 是否被解决" |
| M3 检索盲区不是空位 | 悄悄写成"未被占" | 覆盖不到在审/闭源层时，结论措辞被强制降级，且**原样带进课题卡** |
| §1.5 预注册判据 | 事后补写判据 | 注册阶段出现 `result/evidence` 等结果字段 → **直接拒绝**；已登记结果不得覆盖 |
| §0/G1 假设 ≠ 结论 | 未证伪的候选被写成课题 | 升级课题需 **[空位成立] ∧ [证伪存活] ∧ [预算未超]** 三者同时满足 |
| §6 禁止自封课题 | agent 自行 kill 候选 | 超预算 → 工具强制升级给人；`escalate` 不改变候选状态 |
| §2.2 H1 是假设 | 当公理套用 | 每个子领域必须抽样统计主指标分布，比例低则警告"另找缝隙" |

## 安装

插件装在 profile 里，源码留在工作区（便于改）：

```sh
# 1. 装进 web profile（--profile 后跟 pnpm 参数）
dsh plugin --profile web add /Users/leihenan/Desktop/AgentLab/dsh-plugin-searchlight

# 2. 在 profile 的补丁层里挂载（~/.dsh/profiles/web/cordis.patch.yml）
```

把 `cordis.patch.yml` 的内容改成（原本是空数组 `[]`）：

```yaml
- insert:
    - id: searchlight
      name: '@agentlab/dsh-plugin-searchlight'
      config:
        # 账本目录（相对 workspaceRoot），默认 .dsh-searchlight
        ledgerDir: .dsh-searchlight
        # 策略可覆盖（默认值见下）
        minReplications: 3
        minEffectSize: 3
        maxFalsifiers: 3
        consecutiveKillsToStop: 3
        minKillPowerChars: 40
```

`patchReload: live` 生效时改完即热加载；否则重启 `dsh web`。可用 `dsh --profile web --dump-config` 核对这一行是否进了合成树。

**策略默认值**

| 配置 | 默认 | 含义 |
|---|---|---|
| `minReplications` | 3 | §1.2 同配置重复观测下限 |
| `minEffectSize` | 3 | §1.2 效应量下限（观测差 / 噪声底） |
| `maxFalsifiers` | 3 | §6 单候选证伪次数上限，超限强制升级 |
| `consecutiveKillsToStop` | 3 | §6 连续 K 个候选全灭 → 报告环境不产空位 |
| `minKillPowerChars` | 40 | 证伪设计必须说明"什么观测会与主张不一致" |

## 工具链

```
searchlight_init ──→ searchlight_run ──→ searchlight_claim ──→ searchlight_occupancy
                                                                      │
                          searchlight_topic ←── searchlight_falsifier(design→resolve)
                                                                      │
                                                       searchlight_stop（停止/升级/概览）
```

- `searchlight_init` — 声明子领域与 H1 判据（唯一能新建账本的入口；未声明就记实验会被拒）
- `searchlight_run` — 记录实验与四类异常；过噪声底线与自证伪四问
- `searchlight_claim` — 收敛成"有数字 + 有参照系 + 有设计含义"的量化陈述，自动开候选
- `searchlight_occupancy` — 两阶段占位核查，三态输出，受限可见性强制降级措辞
- `searchlight_falsifier` — `design` 预注册判据 → 跑实验 → `resolve` 登记带数字证据
- `searchlight_topic` — 只有活过证伪才产出课题卡（含完整证据链）
- `searchlight_stop` — `overview` 只读恢复上下文 / `classify` 判定四类停止 / `escalate` 生成升级报告

## 账本

`<workspaceRoot>/.dsh-searchlight/<projectId>.json` —— 纯 JSON、原子写入、可由 `read` 直接查看。

```jsonc
{
  "domain":      { "subfield": "...", "speedOnlyRatio": 1.0, "h1Verdict": "holds" },
  "experiments": [ { "id": "EXP-1", "command": "...", "environment": "..." } ],
  "anomalies":   [ { "id": "SL-A1", "noise": {...}, "effect": { "ratio": 36.25 }, "verdict": "finding" } ],
  "claims":      [ { "id": "SL-C1", "statement": "...", "baseline": "..." } ],
  "candidates":  [ { "id": "CAND-1", "occupancy": {...}, "falsifiers": [ { "registeredAt": "...", "result": "survived" } ] } ],
  "topics":      [ { "topicId": "TOPIC-1", "gapWording": "在本 agent 可见范围内未被占" } ],
  "events":      [ { "at": "...", "kind": "falsifier/designed", "detail": {...} } ]
}
```

账本跨会话持久，是新会话恢复上下文的唯一入口——**不要凭记忆续接上一轮**。

## 验证

```sh
cd dsh-plugin-searchlight

# 首次运行：本地测试需要解析 peer 依赖 @deepseek-ai/dsh-tools。
# 它随 dsh 一起安装，这里用软链指过去即可（node_modules/ 已被 gitignore）。
mkdir -p node_modules/@deepseek-ai
ln -sfn /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools \
        node_modules/@deepseek-ai/dsh-tools

node test/probe.mjs    # 或 npm test
```

`test/probe.mjs` 在 Node 里直接驱动工具层（不起 DSH），共 64 项断言，覆盖：

- **正常路径**：完整走通 init → run → claim → occupancy → falsifier → topic；
- **违规路径必须被拦**（插件的存在意义）：
  - 未 `init` 就写账本 / 单点观测当反常 / 效应量不足硬报 / 缺参照系
  - 自证伪任一 false 仍称"发现" / 噪声待查进入量化陈述
  - partial 状态缺"是否被解决" / 判据 (a) 谎称无人做
  - **设计阶段夹带结果字段**（预注册门）/ 覆盖已登记结果 / killPower 过短
  - 未证伪就升级课题 / 被杀死或超预算的候选升级课题
  - 超预算继续重跑（必须升级给人）
- **边界**：H1 不成立时警告另找缝隙；连续 3 个候选全灭 → 环境不产空位。

## 设计说明

- **没有第三方运行时依赖**：只用 `@deepseek-ai/dsh-tools` 的 `defineTool`（peer）+ Node 内置模块。
  配置校验是手写的普通函数，因此不依赖 `schemastery`，也不会因配置形状漂移在加载期硬失败。
- **门禁在纯函数里**（`src/core/gates.js`，零依赖）：可独立单测、可复用、可移植到别的宿主。
- **工具层只做编排与持久化**（`src/tools.js`、`src/core/store.js`）。
- 已知取舍：占位核查的"是否被解决"是**模型自述**，工具只能强制它填写、无法验证其真实性——
  这是本框架的能力边界，不要把它当成事实核查。

## 目录

```
dsh-plugin-searchlight/
├── package.json
├── src/
│   ├── tools.js          # 7 个工具 + 门禁编排（插件入口）
│   └── core/
│       ├── gates.js      # 纯逻辑门禁（零依赖，可单测）
│       └── store.js      # 账本持久化（原子写）
└── test/probe.mjs        # 64 项断言
```
