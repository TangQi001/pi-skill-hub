import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, type SkillHubConfig } from "./config";
import { EmbeddingIndex } from "./embeddings";
import { installRoot, pullSkills, readManifest, removeSkills } from "./install";
import { SkillLibrary, type SkillMeta } from "./library";
import { readState, runOnboarding, writeState, type OnboardingUI } from "./onboarding";
import { hybridRerank, keywordSearch, type SearchHit } from "./search";

const MAX_DESC = 200;

function formatHit(hit: SearchHit, installed: Set<string>): string {
	const s = hit.skill;
	const desc = s.description.length > MAX_DESC ? `${s.description.slice(0, MAX_DESC)}…` : s.description;
	const flag = installed.has(s.name) ? " [installed]" : "";
	return `- ${s.name}${flag} (score ${hit.score.toFixed(2)}, ${hit.matchKind})\n  ${desc}\n  path: ${s.dir}`;
}

export default function (pi: ExtensionAPI) {
	let cfg: SkillHubConfig;
	let library: SkillLibrary;
	let embedder: EmbeddingIndex | null = null;
	let embedFailed = false;

	function ensureInit(cwd: string): void {
		if (!library) {
			cfg = loadConfig(cwd);
			library = new SkillLibrary(cfg.library);
			embedder = cfg.embeddings ? new EmbeddingIndex(cfg.embeddings) : null;
		}
	}

	async function search(query: string, limit: number, signal?: AbortSignal): Promise<{ hits: SearchHit[]; note?: string }> {
		const skills = await library.getSkills();
		const kwHits = keywordSearch(skills, query, limit);

		if (embedder && !embedFailed) {
			try {
				const [vectors, queryVec] = await Promise.all([
					embedder.ensure(skills, signal),
					embedder.embedQuery(query, signal),
				]);
				const weight = cfg.embeddings?.weight ?? 0.7;
				return { hits: hybridRerank(kwHits, skills, queryVec, vectors, weight, limit) };
			} catch (err) {
				embedFailed = true;
				return {
					hits: kwHits,
					note: `Embedding search unavailable (${err instanceof Error ? err.message : String(err)}); fell back to keyword search.`,
				};
			}
		}
		return { hits: kwHits };
	}

	// Directories where onboarding just installed skills during session_start.
	// resources_discover (which fires right after session_start) contributes them
	// so the skills are active in the very first turn, without /reload.
	const justInstalled = new Set<string>();

	pi.on("resources_discover", async (event, _ctx) => {
		if (justInstalled.size === 0) return;
		const dirs = [...justInstalled];
		justInstalled.clear();
		return { skillPaths: dirs };
	});

	pi.on("session_start", async (_event, ctx) => {
		ensureInit(ctx.cwd);
		// Marker check: does this project already have pulled skills?
		const manifest = await readManifest(ctx.cwd, cfg.installDir);
		if (ctx.hasUI) {
			if (manifest.skills.length > 0) {
				ctx.ui.setStatus("skill-hub", `skill-hub: ${manifest.skills.length} installed`);
			} else {
				ctx.ui.setStatus("skill-hub", "skill-hub: ready");
			}
		}

		// First-run onboarding: ask what this project is, then install matching skills.
		// Skipped when: non-TUI mode, disabled in config, already installed, or previously done/skipped.
		if (ctx.mode !== "tui" || !cfg.onboarding || manifest.skills.length > 0) return;
		if ((await readState(ctx.cwd)) !== null) return;
		const skills = await library.getSkills();
		if (skills.length === 0) return;

		const outcome = await runOnboarding(ctx.ui as OnboardingUI, {
			cwd: ctx.cwd,
			search: async (query, limit) => (await search(query, limit)).hits,
			pull: async (names) => {
				const found: SkillMeta[] = [];
				for (const name of names) {
					const skill = await library.findByName(name);
					if (skill) found.push(skill);
				}
				return pullSkills(found, ctx.cwd, cfg.installDir, false);
			},
		});
		if (outcome) await writeState(ctx.cwd, outcome);
		if (outcome === "done") {
			justInstalled.add(installRoot(ctx.cwd, cfg.installDir));
			const after = await readManifest(ctx.cwd, cfg.installDir);
			if (after.skills.length > 0 && ctx.hasUI) {
				ctx.ui.setStatus("skill-hub", `skill-hub: ${after.skills.length} installed`);
			}
		}
	});

	pi.registerTool({
		name: "skill_hub",
		label: "Skill Hub",
		description:
			"Search the central skill library (level-1, thousands of skills, not loaded into context) and pull the ones you need into this project (level-2). " +
			"Use 'search' to find candidate skills by keywords, 'pull' to install skills by name into the project, 'list' to show installed skills, 'remove' to uninstall, 'info' for full metadata of one skill.",
		promptSnippet: "Find and install specialized skills from the central skill library on demand",
		promptGuidelines: [
			"Use skill_hub with action \"search\" when the user's task might match a specialized skill that is not in the available skills list — do not assume no skill exists.",
			"Use skill_hub with action \"pull\" to install only the skills relevant to the current project; pulled skills are stored under the project and persist across sessions.",
		],
		parameters: Type.Object({
			action: StringEnum(["search", "pull", "list", "remove", "info"] as const),
			query: Type.Optional(Type.String({ description: "Search query (keywords, any language). Required for search." })),
			names: Type.Optional(Type.Array(Type.String(), { description: "Skill names. Required for pull/remove/info." })),
			limit: Type.Optional(Type.Number({ description: "Max search results (default 8)." })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			ensureInit(ctx.cwd);
			const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

			switch (params.action) {
				case "search": {
					if (!params.query) throw new Error("skill_hub search requires 'query'.");
					const skills = await library.getSkills();
					if (skills.length === 0) {
						return text(
							`Skill library is empty or missing. Configured library dirs:\n${cfg.library.join("\n")}\n` +
								`Configure via ~/.pi/agent/skill-hub.json or .pi/skill-hub.json.`,
						);
					}
					const limit = params.limit ?? cfg.defaultLimit;
					const { hits, note } = await search(params.query, limit, signal);
					const manifest = await readManifest(ctx.cwd, cfg.installDir);
					const installed = new Set(manifest.skills.map((s) => s.name));
					if (hits.length === 0) {
						return text(`No skills matched "${params.query}" (library size: ${skills.length}).${note ? `\n${note}` : ""}`);
					}
					const body = hits.map((h) => formatHit(h, installed)).join("\n");
					return text(
						`Found ${hits.length} skill(s) for "${params.query}" (library size: ${skills.length}):\n${body}\n\n` +
							`Use skill_hub action "pull" with the names you need.${note ? `\n${note}` : ""}`,
					);
				}

				case "pull": {
					if (!params.names?.length) throw new Error("skill_hub pull requires 'names'.");
					const found: SkillMeta[] = [];
					const missing: string[] = [];
					for (const name of params.names) {
						const skill = await library.findByName(name);
						if (skill) found.push(skill);
						else missing.push(name);
					}
					const results = await pullSkills(found, ctx.cwd, cfg.installDir, cfg.inlineOnPull);
					const parts: string[] = [];
					for (const r of results) {
						parts.push(
							`✓ ${r.name} ${r.status} → ${r.installPath}` +
								(cfg.inlineOnPull ? "" : `\n  Read ${r.installPath}/SKILL.md to use it.`),
						);
						if (r.content) {
							parts.push(
								`--- SKILL.md content of "${r.name}"${r.contentTruncated ? " (truncated)" : ""} ---\n${r.content}\n--- end ---`,
							);
						}
					}
					if (missing.length) parts.push(`✗ Not found in library: ${missing.join(", ")}`);
					parts.push(
						`Installed under ${installRoot(ctx.cwd, cfg.installDir)}. ` +
							`They will appear in the available-skills list after /reload (and in all future sessions in this project). ` +
							(cfg.inlineOnPull ? "The content above is already usable right now." : ""),
					);
					return text(parts.join("\n"));
				}

				case "list": {
					const manifest = await readManifest(ctx.cwd, cfg.installDir);
					if (manifest.skills.length === 0) return text("No skills installed in this project yet.");
					const lines = manifest.skills.map((s) => `- ${s.name} (pulled ${s.pulledAt})\n  from: ${s.source}`);
					return text(`Installed skills (${manifest.skills.length}) in ${installRoot(ctx.cwd, cfg.installDir)}:\n${lines.join("\n")}`);
				}

				case "remove": {
					if (!params.names?.length) throw new Error("skill_hub remove requires 'names'.");
					const results = await removeSkills(params.names, ctx.cwd, cfg.installDir);
					const lines = results.map((r) => (r.status === "removed" ? `✓ ${r.name} removed` : `- ${r.name} was not installed`));
					lines.push("Run /reload to refresh the available-skills list.");
					return text(lines.join("\n"));
				}

				case "info": {
					if (!params.names?.length) throw new Error("skill_hub info requires 'names' (one skill).");
					const skill = await library.findByName(params.names[0]);
					if (!skill) return text(`Skill "${params.names[0]}" not found in library.`);
					return text(
						`name: ${skill.name}\ndescription: ${skill.description}\n` +
							`keywords: ${skill.keywords.join(", ") || "(none)"}\npath: ${skill.dir}\nlibrary: ${skill.libraryRoot}`,
					);
				}
			}
		},
	});

	pi.registerCommand("skill-hub", {
		description: "Show skill-hub status (library, index, installed skills)",
		handler: async (_args, ctx) => {
			ensureInit(ctx.cwd);
			const skills = await library.getSkills();
			const manifest = await readManifest(ctx.cwd, cfg.installDir);
			const lines = [
				`Library dirs: ${cfg.library.join(", ")}`,
				`Indexed skills: ${skills.length}`,
				`Install dir: ${installRoot(ctx.cwd, cfg.installDir)}`,
				`Installed: ${manifest.skills.length ? manifest.skills.map((s) => s.name).join(", ") : "(none)"}`,
				`Embeddings: ${cfg.embeddings ? `${cfg.embeddings.model} @ ${cfg.embeddings.baseUrl}${embedFailed ? " (failed, keyword fallback)" : ""}` : "disabled"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("skill-hub-setup", {
		description: "Re-run project skill onboarding (describe project, install matching skills)",
		handler: async (_args, ctx) => {
			ensureInit(ctx.cwd);
			const skills = await library.getSkills();
			if (skills.length === 0) {
				ctx.ui.notify("skill-hub: library is empty, nothing to install.", "warning");
				return;
			}
			const outcome = await runOnboarding(ctx.ui as OnboardingUI, {
				cwd: ctx.cwd,
				search: async (query, limit) => (await search(query, limit)).hits,
				pull: async (names) => {
					const found: SkillMeta[] = [];
					for (const name of names) {
						const skill = await library.findByName(name);
						if (skill) found.push(skill);
					}
					return pullSkills(found, ctx.cwd, cfg.installDir, false);
				},
			});
			if (outcome) await writeState(ctx.cwd, outcome);
			if (outcome === "done") {
				// resources_discover already ran for this session; offer a reload so skills activate now.
				const yes = await ctx.ui.confirm("skill-hub", "技能已安装。立即重新加载以在本会话启用？");
				if (yes) {
					await ctx.reload();
					return;
				}
			}
		},
	});

	pi.registerCommand("skill-hub-reindex", {
		description: "Rebuild the skill library index",
		handler: async (_args, ctx) => {
			ensureInit(ctx.cwd);
			const skills = await library.reindex();
			ctx.ui.notify(`skill-hub: reindexed ${skills.length} skills`, "info");
		},
	});
}
