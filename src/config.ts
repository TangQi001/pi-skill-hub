import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface EmbeddingConfig {
	/** OpenAI-compatible endpoint, e.g. "https://api.openai.com/v1" */
	baseUrl: string;
	/** API key literal or "$ENV_VAR" reference */
	apiKey?: string;
	model: string;
	/** Extra weight of embedding score vs keyword score (0-1 blend). Default 0.7 */
	weight?: number;
}

export interface SkillHubConfig {
	/** Level-1 library directories (each scanned recursively for SKILL.md) */
	library: string[];
	/** Project-local install dir, relative to cwd. Default ".pi/skills" */
	installDir: string;
	/** Return full SKILL.md content in pull results so the agent can use skills without reload */
	inlineOnPull: boolean;
	/** Max search results by default */
	defaultLimit: number;
	/** Ask "what is this project" on first session in a project. Default true */
	onboarding: boolean;
	/** Optional embeddings reranker (level-2 quality boost). Falls back to keyword search on failure. */
	embeddings?: EmbeddingConfig;
}

export const DEFAULT_CONFIG: SkillHubConfig = {
	library: [join(homedir(), ".pi", "skill-library")],
	installDir: ".pi/skills",
	inlineOnPull: true,
	defaultLimit: 8,
	onboarding: true,
};

function expandPath(p: string, cwd: string): string {
	let out = p;
	if (out.startsWith("~/") || out === "~") out = join(homedir(), out.slice(1));
	return resolve(cwd, out);
}

function readJson(path: string): Partial<SkillHubConfig> | null {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf8")) as Partial<SkillHubConfig>;
	} catch {
		return null;
	}
}

/**
 * Config resolution (later wins):
 *   defaults < ~/.pi/agent/skill-hub.json (global) < <cwd>/.pi/skill-hub.json (project)
 */
export function loadConfig(cwd: string): SkillHubConfig {
	const globalCfg = readJson(join(homedir(), ".pi", "agent", "skill-hub.json")) ?? {};
	const projectCfg = readJson(join(cwd, ".pi", "skill-hub.json")) ?? {};
	const merged: SkillHubConfig = {
		...DEFAULT_CONFIG,
		...globalCfg,
		...projectCfg,
		library:
			(projectCfg.library as string[] | undefined) ??
			(globalCfg.library as string[] | undefined) ??
			DEFAULT_CONFIG.library,
		embeddings: (projectCfg.embeddings ?? globalCfg.embeddings) as EmbeddingConfig | undefined,
	};
	merged.library = merged.library.map((p) => expandPath(p, cwd));
	return merged;
}

export function resolveApiKey(apiKey: string | undefined): string | undefined {
	if (!apiKey) return undefined;
	const m = apiKey.match(/^\$\{?([A-Z0-9_]+)\}?$/i);
	if (m) return process.env[m[1]];
	return apiKey;
}
