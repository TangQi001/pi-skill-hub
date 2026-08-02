import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { PullResult } from "./install";
import type { SearchHit } from "./search";

/** Minimal UI surface so the flow can be tested with a mock. */
export interface OnboardingUI {
	input(title: string, placeholder?: string): Promise<string | undefined>;
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface OnboardingDeps {
	cwd: string;
	search(query: string, limit: number): Promise<SearchHit[]>;
	pull(names: string[]): Promise<PullResult[]>;
}

type OnboardingStatus = "done" | "skipped";

interface StateFile {
	onboarding: OnboardingStatus;
	at: string;
}

const STATE_FILE = join(".pi", "skill-hub.state.json");

export async function readState(cwd: string): Promise<StateFile | null> {
	try {
		return JSON.parse(await fs.readFile(join(cwd, STATE_FILE), "utf8")) as StateFile;
	} catch {
		return null;
	}
}

export async function writeState(cwd: string, onboarding: OnboardingStatus): Promise<void> {
	try {
		await fs.mkdir(join(cwd, ".pi"), { recursive: true });
		const state: StateFile = { onboarding, at: new Date().toISOString() };
		await fs.writeFile(join(cwd, STATE_FILE), JSON.stringify(state, null, 2));
	} catch {
		// read-only project dir etc.: non-fatal
	}
}

const ALL = "全部安装";
const PICK = "逐个选择";
const SKIP = "跳过";
const DONE_PICK = "✓ 完成选择";

function shortDesc(s: string, n = 50): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * First-run project onboarding:
 * describe the project → search library → install chosen skills → persist marker.
 * Returns "done" | "skipped" | null (nothing happened / not applicable).
 */
export async function runOnboarding(ui: OnboardingUI, deps: OnboardingDeps): Promise<OnboardingStatus | null> {
	const description = await ui.input(
		"skill-hub：这是什么项目？",
		"一句话描述，例如：短剧视频生成工具 / React 管理系统（留空跳过）",
	);
	if (!description?.trim()) {
		ui.notify("skill-hub：已跳过项目技能配置。以后可运行 /skill-hub-setup 重新配置。", "info");
		return "skipped";
	}

	const hits = await deps.search(description.trim(), 6);
	if (hits.length === 0) {
		ui.notify(`skill-hub：技能库中没有匹配「${description.trim()}」的技能，跳过。`, "info");
		return "done";
	}

	const mode = await ui.select(
		`skill-hub：为「${description.trim()}」找到 ${hits.length} 个匹配技能`,
		[ALL, PICK, SKIP],
	);

	let chosen: SearchHit[] = [];
	if (mode === ALL) {
		chosen = hits;
	} else if (mode === PICK) {
		const remaining = [...hits];
		for (;;) {
			const options = remaining.map((h) => `${h.skill.name} — ${shortDesc(h.skill.description)}`);
			const sel = await ui.select("选择要安装的技能", [...options, DONE_PICK]);
			if (!sel || sel === DONE_PICK) break;
			const name = sel.split(" — ")[0];
			const hit = remaining.find((h) => h.skill.name === name);
			if (hit) {
				chosen.push(hit);
				remaining.splice(remaining.indexOf(hit), 1);
			}
			if (remaining.length === 0) break;
		}
	} else {
		ui.notify("skill-hub：已跳过。以后可运行 /skill-hub-setup 重新配置。", "info");
		return "skipped";
	}

	if (chosen.length === 0) {
		ui.notify("skill-hub：未选择任何技能，已跳过。", "info");
		return "skipped";
	}

	const results = await deps.pull(chosen.map((h) => h.skill.name));
	ui.notify(
		`skill-hub：已安装 ${results.length} 个技能到本项目：${results.map((r) => r.name).join(", ")}。本会话即可使用。`,
		"info",
	);
	return "done";
}
