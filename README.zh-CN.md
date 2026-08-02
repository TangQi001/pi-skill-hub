# pi-skill-hub

[English README](README.md)

Pi 智能体的**两级技能发现**扩展：让 AI 以最小上下文代价，从一个可容纳成千上万个技能的中心库中，按需检索并安装当前项目需要的技能。

本包已经按 Pi Package 规范配置，并发布到 GitHub：<https://github.com/TangQi001/pi-skill-hub>。当前通过 Git 分发，尚未发布到 npm，因此还不会出现在 `pi.dev/packages` 的公共目录中。

## 作为 Pi Package 安装

本地测试：

```bash
pi install /absolute/path/to/pi-skill-hub
```

GitHub 安装：

```bash
pi install git:github.com/TangQi001/pi-skill-hub@v0.1.2
```

npm 发布后可以这样安装：

```bash
pi install npm:<package-name>@0.1.2
```

## 两级策略

| 层级 | 角色 | 实现 |
|------|------|------|
| 一级 | 中心技能库（可成千上万） | 任意目录（默认 `~/.pi/skill-library/`），**不进入** Pi 的技能扫描路径，上下文代价为零。扩展只解析每个 `SKILL.md` 的 frontmatter（name/description/keywords）建立轻量索引。 |
| 二级 | 筛选 + 按需安装 | AI 调用 `skill_hub` 工具：关键词（可选 embedding）检索索引 → `pull` 把命中技能复制到项目本地 `.pi/skills/`。该目录成为"已获得技能"的标志，Pi 原生发现它们，后续会话自动可用。 |

系统提示词中常驻的只有 `skill_hub` 这一个工具的说明，这就是全部固定代价。

## 安装

```bash
# 方式一：通过 GitHub Pi Package 安装（推荐）
pi install git:github.com/TangQi001/pi-skill-hub@v0.1.2

# 方式二：本地扩展目录
cp -r pi-skill-hub ~/.pi/agent/extensions/skill-hub

# 方式三：通过 settings.json 指向任意路径
{ "extensions": ["/path/to/pi-skill-hub"] }
```

## 配置

全局 `~/.pi/agent/skill-hub.json`，项目可覆盖：`<项目>/.pi/skill-hub.json`

```json
{
  "library": ["~/.pi/skill-library", "/data/team-skills"],
  "installDir": ".pi/skills",
  "inlineOnPull": true,
  "defaultLimit": 8,
  "onboarding": true,
  "embeddings": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "$OPENAI_API_KEY",
    "model": "text-embedding-3-small",
    "weight": 0.7
  }
}
```

- `library`：一级库目录列表，递归扫描 `SKILL.md`。
- `installDir`：项目内安装位置，默认 `.pi/skills`（Pi 原生技能路径）。
- `inlineOnPull`：pull 时在工具结果里直接带回 SKILL.md 全文，当前会话立即可用，无需等待 reload。
- `defaultLimit`：默认检索结果数量。
- `onboarding`：首次打开项目时是否询问项目类型并推荐技能，默认 `true`。
- `embeddings`：可选。配置后用 OpenAI 兼容接口做向量检索，与关键词分数加权混合（`weight` 为向量权重）；向量按内容哈希缓存在 `~/.cache/pi-skill-hub/`，失败自动降级为纯关键词检索。

## AI 侧工具：`skill_hub`

| action | 参数 | 说明 |
|--------|------|------|
| `search` | `query`, `limit?` | 检索索引，返回排序后的候选（名称/分数/简介/路径/是否已安装）。中英文均可（英文按词、中文按二元字组）。 |
| `pull` | `names[]` | 把技能复制到项目 `installDir`，更新 `.skill-hub.json` 清单，并内联返回 SKILL.md 内容。 |
| `list` | — | 列出本项目已安装技能。 |
| `remove` | `names[]` | 从项目卸载。 |
| `info` | `names[0]` | 查看单个技能完整元数据。 |

用户侧命令：`/skill-hub`（状态）、`/skill-hub-reindex`（重建索引）、`/skill-hub-setup`（重新运行项目引导）。

## 项目开机引导（onboarding）

首次在某个项目打开 pi 时，扩展检查 `.pi` 下是否有本插件安装的技能：

1. **已有**（`.pi/skills/.skill-hub.json` 清单非空）→ 状态栏显示数量，不打扰。
2. **没有** → 弹出输入框问「这是什么项目？」→ 用描述检索一级库 → 展示前 6 个候选，可选 **全部安装 / 逐个选择 / 跳过** → 安装到 `.pi/skills/`。
3. 安装发生在 `session_start`（先于 `resources_discover`），装完的技能**首轮对话即可用**，无需 `/reload`。
4. 无论安装还是跳过，都写入 `.pi/skill-hub.state.json` 标志；**之后打开该项目永不再问**。想重新配置随时运行 `/skill-hub-setup`（手动模式装完可选择立即 reload）。

仅在 TUI 交互模式触发；print/rpc 模式静默跳过。配置项 `"onboarding": false` 可整体关闭。

## 工作流程

1. 打开智能体 → 首次触发上面的开机引导；之后扩展检查 `.pi/skills/.skill-hub.json` 标志，状态栏显示已安装数量。
2. AI 遇到任务 → `skill_hub search`（只读索引，代价极小）→ `pull` 命中的 1~2 个技能。
3. pull 后技能内容当即可用；`/reload`（或下次会话）后进入 `available_skills` 正式列表，之后可直接 `read` SKILL.md 或用 `/skill:<name>`。
4. 需要新技能时随时重复第 2 步。

> 注意：`.pi/` 下的技能属于项目本地资源，需要项目被信任（交互模式会询问一次并记住；print 模式用 `--approve`）。

## 嵌入检索示例

可使用 SiliconFlow 等 OpenAI 兼容服务：

```json
{
  "embeddings": {
    "baseUrl": "https://api.siliconflow.cn/v1",
    "apiKey": "$SILICONFLOW_API_KEY",
    "model": "Qwen/Qwen3-Embedding-8B",
    "weight": 0.7
  }
}
```

不要把真实 API key 写入 Git 仓库；优先使用环境变量引用。

## 验证过的行为

- 英文检索 `pdf extract` → 命中 `pdf-tools`。
- 中文检索 `视频字幕` → 命中 `video-edit`。
- 语义检索 `用我自己的声音给视频配音` → `vid-tts-ali` 排在前面。
- `pull` 后项目技能在后续会话中出现在 `available_skills`。
- GitHub Pi Package 安装测试通过：`git:github.com/TangQi001/pi-skill-hub@v0.1.2`。

## 后续可扩展方向

- 远程库同步（git/npm 包作为一级库，`pull` 时下载）。
- 基于会话内容的自动推荐（`before_agent_start` 里对用户首条 prompt 静默检索并提示候选）。
- 检索遥测：记录命中率，反哺 description/keywords 质量。
