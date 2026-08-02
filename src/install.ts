import { existsSync, promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { SkillMeta } from "./library";

export interface InstalledEntry {
	name: string;
	source: string; // absolute path of the library skill dir it was pulled from
	pulledAt: string; // ISO timestamp
}

interface Manifest {
	version: 1;
	skills: InstalledEntry[];
}

// Serialize pull/remove operations (tool calls may run in parallel).
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
	const next = queue.then(fn, fn);
	queue = next.catch(() => {});
	return next;
}

export function installRoot(cwd: string, installDir: string): string {
	return resolve(cwd, installDir);
}

function manifestPath(cwd: string, installDir: string): string {
	return join(installRoot(cwd, installDir), ".skill-hub.json");
}

export async function readManifest(cwd: string, installDir: string): Promise<Manifest> {
	try {
		const raw = await fs.readFile(manifestPath(cwd, installDir), "utf8");
		return JSON.parse(raw) as Manifest;
	} catch {
		return { version: 1, skills: [] };
	}
}

async function writeManifest(cwd: string, installDir: string, manifest: Manifest): Promise<void> {
	await fs.mkdir(installRoot(cwd, installDir), { recursive: true });
	await fs.writeFile(manifestPath(cwd, installDir), JSON.stringify(manifest, null, 2));
}

export interface PullResult {
	name: string;
	status: "installed" | "updated";
	installPath: string;
	/** SKILL.md content, when inlineOnPull is enabled */
	content?: string;
	contentTruncated?: boolean;
}

const INLINE_LIMIT = 12_000; // chars per SKILL.md
const INLINE_TOTAL_LIMIT = 40_000; // chars across all pulled skills

export function pullSkills(
	skills: SkillMeta[],
	cwd: string,
	installDir: string,
	inline: boolean,
): Promise<PullResult[]> {
	return serialize(async () => {
		const root = installRoot(cwd, installDir);
		const manifest = await readManifest(cwd, installDir);
		const results: PullResult[] = [];
		let inlineBudget = INLINE_TOTAL_LIMIT;

		for (const skill of skills) {
			const dest = join(root, skill.name);
			const existed = existsSync(dest);
			await fs.cp(skill.dir, dest, { recursive: true, force: true });

			const entry: InstalledEntry = {
				name: skill.name,
				source: skill.dir,
				pulledAt: new Date().toISOString(),
			};
			const i = manifest.skills.findIndex((s) => s.name === skill.name);
			if (i >= 0) manifest.skills[i] = entry;
			else manifest.skills.push(entry);

			const result: PullResult = {
				name: skill.name,
				status: existed ? "updated" : "installed",
				installPath: dest,
			};

			if (inline && inlineBudget > 0) {
				try {
					let content = await fs.readFile(join(dest, "SKILL.md"), "utf8");
					if (content.length > Math.min(INLINE_LIMIT, inlineBudget)) {
						content = content.slice(0, Math.min(INLINE_LIMIT, inlineBudget));
						result.contentTruncated = true;
					}
					inlineBudget -= content.length;
					result.content = content;
				} catch {
					// SKILL.md vanished between index and copy; ignore
				}
			}
			results.push(result);
		}

		await writeManifest(cwd, installDir, manifest);
		return results;
	});
}

export function removeSkills(
	names: string[],
	cwd: string,
	installDir: string,
): Promise<Array<{ name: string; status: "removed" | "not-installed" }>> {
	return serialize(async () => {
		const root = installRoot(cwd, installDir);
		const manifest = await readManifest(cwd, installDir);
		const results: Array<{ name: string; status: "removed" | "not-installed" }> = [];
		for (const name of names) {
			const i = manifest.skills.findIndex((s) => s.name === name);
			if (i < 0) {
				results.push({ name, status: "not-installed" });
				continue;
			}
			manifest.skills.splice(i, 1);
			await fs.rm(join(root, name), { recursive: true, force: true });
			results.push({ name, status: "removed" });
		}
		await writeManifest(cwd, installDir, manifest);
		return results;
	});
}
