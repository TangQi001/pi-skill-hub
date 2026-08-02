import type { SkillMeta } from "./library";

export interface SearchHit {
	skill: SkillMeta;
	score: number;
	/** "keyword" | "embedding" | "hybrid" */
	matchKind: string;
}

/**
 * Zero-dependency tokenizer:
 * - latin/number words (e.g. "pdf", "gpt-4o", "c++")
 * - CJK bigrams (Chinese/Japanese/Korean need no word segmenter)
 */
export function tokenize(text: string): string[] {
	const lower = text.toLowerCase();
	const tokens = new Set<string>();
	for (const w of lower.match(/[a-z0-9][a-z0-9_+.#-]*/g) ?? []) tokens.add(w);
	for (const seg of lower.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? []) {
		if (seg.length === 1) tokens.add(seg);
		else for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2));
	}
	return [...tokens];
}

const NAME_W = 5;
const KEYWORD_W = 4;
const DESC_W = 1;

/**
 * IDF-weighted keyword search: tokens common across many skills (e.g. "短剧"
 * in a library full of drama skills) count less; distinctive tokens count more.
 */
export function keywordSearch(skills: SkillMeta[], query: string, limit: number): SearchHit[] {
	const qTokens = tokenize(query);
	if (qTokens.length === 0) return [];
	const qLower = query.toLowerCase().trim();

	// Document frequency over name+keywords+description per skill
	const df = new Map<string, number>();
	const perSkill = skills.map((skill) => {
		// Name parts too: "short-drama-write" also matches "write", "drama", ...
		const nameTokens = new Set([...tokenize(skill.name), ...skill.name.toLowerCase().split(/[-_]+/).filter(Boolean)]);
		const kwTokens = new Set(tokenize(skill.keywords.join(" ")));
		const descTokens = new Set(tokenize(skill.description));
		const all = new Set([...nameTokens, ...kwTokens, ...descTokens]);
		for (const t of all) df.set(t, (df.get(t) ?? 0) + 1);
		return { skill, nameTokens, kwTokens, descTokens };
	});
	const n = skills.length;
	const idf = (t: string) => Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1;

	const hits: SearchHit[] = [];
	for (const { skill, nameTokens, kwTokens, descTokens } of perSkill) {
		let score = 0;
		for (const t of qTokens) {
			const w = idf(t);
			if (nameTokens.has(t)) score += NAME_W * w;
			if (kwTokens.has(t)) score += KEYWORD_W * w;
			if (descTokens.has(t)) score += DESC_W * w;
		}
		// Phrase bonuses
		if (qLower.length >= 2) {
			if (skill.name.toLowerCase().includes(qLower)) score += 8;
			else if (skill.description.toLowerCase().includes(qLower)) score += 2;
		}
		if (score > 0) hits.push({ skill, score, matchKind: "keyword" });
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, limit);
}

export function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Blend keyword hits with embedding cosine similarity. */
export function hybridRerank(
	keywordHits: SearchHit[],
	skills: SkillMeta[],
	queryVec: number[],
	vectors: Map<string, number[]>,
	weight: number,
	limit: number,
): SearchHit[] {
	const kwScore = new Map(keywordHits.map((h) => [h.skill.name, h.score]));
	const maxKw = Math.max(1, ...keywordHits.map((h) => h.score));
	const hits: SearchHit[] = [];
	for (const skill of skills) {
		const vec = vectors.get(skill.name);
		if (!vec) continue;
		const sim = cosine(queryVec, vec); // 0..1-ish
		const kw = (kwScore.get(skill.name) ?? 0) / maxKw; // normalized 0..1
		const score = weight * sim + (1 - weight) * kw;
		if (score > 0.05) {
			hits.push({ skill, score, matchKind: kw > 0 ? "hybrid" : "embedding" });
		}
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, limit);
}
