import { createHash } from "node:crypto";
import { existsSync, promises as fs, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveApiKey, type EmbeddingConfig } from "./config";
import type { SkillMeta } from "./library";

/**
 * Optional OpenAI-compatible embeddings backend for level-2 retrieval.
 * Vectors are cached on disk keyed by content hash, so re-indexing thousands
 * of skills only calls the API for new/changed skills.
 */
export class EmbeddingIndex {
	private cacheDir = join(homedir(), ".cache", "pi-skill-hub");
	private vectors = new Map<string, number[]>();
	private loaded = false;

	constructor(private readonly cfg: EmbeddingConfig) {}

	private cacheFile(): string {
		const key = createHash("sha1").update(`${this.cfg.baseUrl}|${this.cfg.model}`).digest("hex").slice(0, 12);
		return join(this.cacheDir, `embeddings-${key}.json`);
	}

	private textOf(skill: SkillMeta): string {
		return `${skill.name}\n${skill.keywords.join(" ")}\n${skill.description}`;
	}

	private hashOf(text: string): string {
		return createHash("sha1").update(text).digest("hex");
	}

	private async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			if (existsSync(this.cacheFile())) {
				const raw = JSON.parse(await fs.readFile(this.cacheFile(), "utf8")) as Record<string, { h: string; v: number[] }>;
				for (const [name, entry] of Object.entries(raw)) this.vectors.set(name, entry.v);
				// hashes stored separately
				this.hashes = new Map(Object.entries(raw).map(([name, e]) => [name, e.h]));
			}
		} catch {
			this.vectors.clear();
		}
	}

	private hashes = new Map<string, string>();

	private async save(): Promise<void> {
		try {
			mkdirSync(this.cacheDir, { recursive: true });
			const out: Record<string, { h: string; v: number[] }> = {};
			for (const [name, v] of this.vectors) out[name] = { h: this.hashes.get(name) ?? "", v };
			await fs.writeFile(this.cacheFile(), JSON.stringify(out));
		} catch {
			// cache write failure is non-fatal
		}
	}

	private async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
		const apiKey = resolveApiKey(this.cfg.apiKey);
		const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/embeddings`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify({ model: this.cfg.model, input: texts }),
			signal,
		});
		if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
		const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
		return data.data.map((d) => d.embedding);
	}

	/** Ensure vectors exist for all skills; embeds only missing/changed ones (batched). */
	async ensure(skills: SkillMeta[], signal?: AbortSignal): Promise<Map<string, number[]>> {
		await this.load();
		const stale: SkillMeta[] = [];
		for (const s of skills) {
			const h = this.hashOf(this.textOf(s));
			if (this.hashes.get(s.name) !== h || !this.vectors.has(s.name)) stale.push(s);
		}
		const BATCH = 64;
		for (let i = 0; i < stale.length; i += BATCH) {
			const batch = stale.slice(i, i + BATCH);
			const vecs = await this.embed(batch.map((s) => this.textOf(s)), signal);
			for (let j = 0; j < batch.length; j++) {
				this.vectors.set(batch[j].name, vecs[j]);
				this.hashes.set(batch[j].name, this.hashOf(this.textOf(batch[j])));
			}
		}
		if (stale.length > 0) await this.save();
		return this.vectors;
	}

	async embedQuery(query: string, signal?: AbortSignal): Promise<number[]> {
		const [vec] = await this.embed([query], signal);
		return vec;
	}
}
