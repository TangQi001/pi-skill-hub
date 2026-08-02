# pi-skill-managerhub

[中文说明](README.zh-CN.md)

A two-level skill discovery extension for the Pi coding agent. It lets an agent search a large central skill library at low context cost, then install only the skills needed by the current project.

This package follows the [Pi Package](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) format. The source repository is published on GitHub, and the npm package name is `pi-skill-managerhub`:

<https://github.com/TangQi001/pi-skill-hub>

The package is available from both GitHub and npm. Because it carries the `pi-package` keyword, it can also be indexed by the public `pi.dev/packages` catalog.

## Install as a Pi Package

Install the published GitHub package:

```bash
pi install git:github.com/TangQi001/pi-skill-hub@v0.1.3
```

Try a local checkout:

```bash
pi install /absolute/path/to/pi-skill-hub
```

Install the npm package with:

```bash
pi install npm:pi-skill-managerhub@0.1.3
```

## Two-Level Strategy

| Level | Role | Implementation |
|---|---|---|
| Level 1 | Central library with thousands of skills | One or more directories, defaulting to `~/.pi/skill-library/`. The library is not included in Pi's normal skill discovery paths, so it does not add all skill content to the prompt. The extension only builds a lightweight index from `SKILL.md` frontmatter (`name`, `description`, and `keywords`). |
| Level 2 | Filtering and on-demand installation | The agent calls the `skill_hub` tool to search the index, then pulls selected skills into the project-local `.pi/skills/` directory. That directory is the marker for skills acquired by the project, and Pi discovers those skills in later sessions. |

Only the small `skill_hub` tool description remains permanently available to the model. Full skill instructions are loaded only when needed.

## Configuration

Global configuration:

```text
~/.pi/agent/skill-hub.json
```

A project-level file can override it:

```text
<project>/.pi/skill-hub.json
```

Example:

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

- `library`: One or more level-1 library directories. Each is scanned recursively for `SKILL.md`.
- `installDir`: Project-local installation directory. Defaults to `.pi/skills`, a native Pi skill location.
- `inlineOnPull`: Returns the pulled `SKILL.md` content in the tool result so the current turn can use it immediately.
- `defaultLimit`: Default number of search results.
- `onboarding`: Enables the first-run project onboarding flow. Defaults to `true`.
- `embeddings`: Optional OpenAI-compatible embedding search. The vector score is blended with the keyword score using `weight`. Vectors are cached by content hash in `~/.cache/pi-skill-hub/`; failed embedding requests fall back to keyword search.

### SiliconFlow Example

The extension also works with SiliconFlow and other OpenAI-compatible endpoints:

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

Keep real API keys out of Git repositories. Prefer environment variable references.

## Agent Tool: `skill_hub`

| Action | Parameters | Description |
|---|---|---|
| `search` | `query`, optional `limit` | Search the library and return ranked candidates with names, scores, descriptions, paths, and installation status. English and Chinese queries are supported. |
| `pull` | `names[]` | Copy selected skills into the project's `installDir`, update the `.skill-hub.json` manifest, and optionally return the full `SKILL.md` content. |
| `list` | — | List skills installed in the current project. |
| `remove` | `names[]` | Remove selected project-local skills. |
| `info` | `names[0]` | Show complete metadata for one library skill. |

User commands:

- `/skill-hub` — show library, index, embedding, and installation status.
- `/skill-hub-reindex` — rebuild the level-1 library index.
- `/skill-hub-setup` — run project onboarding again.

## First-Run Project Onboarding

When Pi is opened in a project for the first time, the extension checks whether the project already has skills acquired through Skill Hub:

1. If `.pi/skills/.skill-hub.json` contains installed skills, the extension shows the count in the status bar and does not interrupt the user.
2. If there are no installed skills, the extension asks: **“What kind of project is this?”**
3. It searches the level-1 library and presents up to six candidates.
4. The user can choose **Install all**, **Choose individually**, or **Skip**.
5. The selected skills are installed into `.pi/skills/`.
6. The extension writes `.pi/skill-hub.state.json`, so the project is not asked again on later sessions.

Onboarding runs only in interactive TUI mode. Print and RPC modes skip it silently. Set `"onboarding": false` to disable it.

Skills installed during startup are contributed to Pi's resource discovery flow and are available in the first conversation turn without a reload. Skills installed later through `skill_hub` are persistent and appear after `/reload` or in the next session.

## Typical Workflow

1. Open Pi in a new project and complete the one-time onboarding prompt.
2. When a task needs another capability, call `skill_hub` with `search`.
3. Pull only the one or two relevant skills.
4. Use the pulled skill immediately, or let Pi discover it after reload/the next session.
5. Repeat the search-and-pull flow whenever the project grows.

> Project-local `.pi/` resources require project trust. Interactive Pi asks for trust once; use `--approve` in non-interactive tests.

## Verified Behavior

- `pdf extract` finds `pdf-tools`.
- `视频字幕` finds `video-edit`.
- `用我自己的声音给视频配音` ranks `vid-tts-ali` above the default-voice skill.
- Pulled skills appear in `available_skills` in subsequent sessions.
- The published GitHub package installs successfully with:

  ```bash
  pi install git:github.com/TangQi001/pi-skill-hub@v0.1.3
  ```
- The npm package is published as `pi-skill-managerhub`.

## Possible Future Improvements

- Remote level-1 library synchronization from Git or npm sources.
- Silent recommendations based on the first user prompt.
- Search telemetry to improve skill descriptions and keyword quality.
