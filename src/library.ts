import { existsSync, promises as fs, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface SkillMeta {
	name: string;
	description: string;
	keywords: string[];
	/** Absolute path of SKILL.md */
	path: string;
	/** Absolute path of the skill directory */
	dir: string;
	/** Which library root this skill came from */
	libraryRoot: string;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", "__pycache__"]);

/** Minimal YAML-frontmatter parser: handles `key: value`, quoted values, and metadata.keywords lists. */
export function parseFrontmatter(content: string): { name?: string; description?: string; keywords: string[] } {
	const result: { name?: string; description?: string; keywords: string[] } = { keywords: [] };
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return result;
	const lines = m[1].split(/\r?\n/);

	let inMetadata = false;
	let pendingListKey: string | null = null;

	const unquote = (v: string) => v.trim().replace(/^["'](.*)["']\s*$/, "$1").trim();

	for (let li = 0; li < lines.length; li++) {
		const rawLine = lines[li];
		const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		if (indent === 0) {
			inMetadata = false;
			pendingListKey = null;
			const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
			if (!kv) continue;
			const [, key, value] = kv;
			// YAML block scalars: `key: >` (folded) or `key: |` (literal)
			if ((value === ">" || value === "|" || value === ">-" || value === "|-") && (key === "description" || key === "name")) {
				const block: string[] = [];
				while (li + 1 < lines.length) {
					const next = lines[li + 1];
					const nextIndent = next.match(/^\s*/)?.[0].length ?? 0;
					if (next.trim() !== "" && nextIndent === 0) break;
					if (next.trim() !== "") block.push(next.trim());
					li++;
				}
				const joined = value.startsWith(">") ? block.join(" ") : block.join("\n");
				if (key === "description") result.description = joined;
				else result.name = joined;
				continue;
			}
			if (key === "name") result.name = unquote(value);
			else if (key === "description") result.description = unquote(value);
			else if (key === "keywords") {
				if (value.startsWith("[")) {
					result.keywords = value.replace(/[[\]]/g, "").split(",").map(unquote).filter(Boolean);
				} else if (value) {
					result.keywords = value.split(",").map(unquote).filter(Boolean);
				} else {
					pendingListKey = "keywords";
				}
			} else if (key === "metadata") {
				inMetadata = true;
			}
			continue;
		}

		// Indented lines: metadata.keywords or "- item" list entries
		if (pendingListKey === "keywords" && line.startsWith("- ")) {
			result.keywords.push(unquote(line.slice(2)));
			continue;
		}
		if (inMetadata) {
			const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
			if (kv && kv[1] === "keywords") {
				const value = kv[2];
				if (value.startsWith("[")) {
					result.keywords = value.replace(/[[\]]/g, "").split(",").map(unquote).filter(Boolean);
				} else if (value) {
					result.keywords = value.split(",").map(unquote).filter(Boolean);
				} else {
					pendingListKey = "keywords";
				}
			}
		}
	}
	return result;
}

async function readFrontmatterBlock(path: string): Promise<string> {
	// Only read the first 4KB — frontmatter always lives at the top.
	const fh = await fs.open(path, "r");
	try {
		const buf = Buffer.alloc(4096);
		const { bytesRead } = await fh.read(buf, 0, 4096, 0);
		return buf.toString("utf8", 0, bytesRead);
	} finally {
		await fh.close();
	}
}

export class SkillLibrary {
	private skills: SkillMeta[] = [];
	private indexed = false;
	private indexing: Promise<SkillMeta[]> | null = null;

	constructor(private readonly roots: string[]) {}

	/** Lazily build the index on first use; safe to call concurrently. */
	async getSkills(): Promise<SkillMeta[]> {
		if (this.indexed) return this.skills;
		if (!this.indexing) {
			this.indexing = this.build().then((skills) => {
				this.skills = skills;
				this.indexed = true;
				return skills;
			});
		}
		return this.indexing;
	}

	async reindex(): Promise<SkillMeta[]> {
		this.indexed = false;
		this.indexing = null;
		return this.getSkills();
	}

	isIndexed(): boolean {
		return this.indexed;
	}

	get size(): number {
		return this.skills.length;
	}

	async findByName(name: string): Promise<SkillMeta | undefined> {
		const skills = await this.getSkills();
		return skills.find((s) => s.name === name);
	}

	private async build(): Promise<SkillMeta[]> {
		const skillFiles: string[] = [];
		for (const root of this.roots) {
			if (!existsSync(root)) continue;
			walk(root, skillFiles);
		}
		const out: SkillMeta[] = [];
		const seen = new Set<string>();
		for (const path of skillFiles) {
			const root = this.roots.find((r) => path.startsWith(r)) ?? "";
			try {
				const head = await readFrontmatterBlock(path);
				const fm = parseFrontmatter(head);
				const name = fm.name ?? basename(join(path, ".."));
				if (seen.has(name)) continue; // first wins, same as pi
				seen.add(name);
				if (!fm.description) continue; // pi skips skills without description
				out.push({
					name,
					description: fm.description,
					keywords: fm.keywords,
					path,
					dir: join(path, ".."),
					libraryRoot: root,
				});
			} catch {
				// unreadable file: skip
			}
		}
		return out;
	}
}

function walk(dir: string, out: string[], depth = 0): void {
	if (depth > 12) return;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			walk(full, out, depth + 1);
		} else if (entry === "SKILL.md") {
			out.push(full);
		}
	}
}
