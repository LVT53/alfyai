import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { earlierJoins } from "./earlier-rerank";

/**
 * The Earlier gate's acceptance table, held to the code: the production
 * reranker's scores and the word rule's verdicts for the blind set (86 messages
 * about one of 43 Earlier entries, 40 unrelated, 10 Hungarian messages about
 * English entries; every entry counted as ranked in the top three for every
 * message), run through `earlierJoins` at the defaults the settings ship
 * (`config-store.earlier-rerank.test.ts` holds those). The record, its method
 * and the raw scores are in docs/plans/hindsight-memory/
 * label-migration-acceptance/earlier-rerank/. Synthetic text only.
 */
const RECORD = join(
	process.cwd(),
	"docs/plans/hindsight-memory/label-migration-acceptance/earlier-rerank",
);
const read = <T>(name: string): T =>
	JSON.parse(readFileSync(join(RECORD, name), "utf8"));

type Kind = "about" | "unrelated" | "cross";
const data = read<{
	facts: string[];
	about: { t: number }[];
	unrelated: unknown[];
	cross: { t: number }[];
}>("data.json");
/** scores[kind][message][fact] */
const scores = read<Record<Kind, number[][]>>("scores.json");
/** words[kind][message][fact]: the word rule says the message mentions the entry */
const words = read<Record<Kind, boolean[][]>>("lex.json");

const DEFAULTS = { min: 0.002, wordMin: 0.0005 };

function measure(
	joins: (score: number, mentioned: boolean) => boolean,
): Record<"about" | "extra" | "unrelated" | "cross", number> {
	const joined = (kind: Kind, message: number, fact: number) =>
		joins(scores[kind][message][fact], words[kind][message][fact]);
	const facts = data.facts.map((_, fact) => fact);
	return {
		about: data.about.filter(({ t }, i) => joined("about", i, t)).length,
		extra: data.about.filter(({ t }, i) =>
			facts.some((fact) => fact !== t && joined("about", i, fact)),
		).length,
		unrelated: data.unrelated.filter((_, i) =>
			facts.some((fact) => joined("unrelated", i, fact)),
		).length,
		cross: data.cross.filter(({ t }, i) => joined("cross", i, t)).length,
	};
}

describe("the Earlier gate on the blind set", () => {
	it("holds the sizes the record states", () => {
		expect(data.facts).toHaveLength(43);
		expect([
			data.about.length,
			data.unrelated.length,
			data.cross.length,
		]).toEqual([86, 40, 10]);
	});

	it("is the word rule's 52% about, 25% unrelated and no cross-language without the reranker", () => {
		expect(measure((_score, mentioned) => mentioned)).toEqual({
			about: 45,
			extra: 45,
			unrelated: 10,
			cross: 0,
		});
	});

	it("is 77% about, 16% with a wrong extra entry, 8% unrelated and 70% cross-language with the two floors", () => {
		const result = measure((score, mentioned) =>
			earlierJoins(score, () => mentioned, DEFAULTS),
		);
		expect(result).toEqual({ about: 66, extra: 14, unrelated: 3, cross: 7 });
		expect(Math.round((100 * result.about) / 86)).toBe(77);
		expect(Math.round((100 * result.extra) / 86)).toBe(16);
		expect(Math.round((100 * result.unrelated) / 40)).toBe(8);
		expect(result.unrelated / 40).toBeLessThanOrEqual(0.1);
	});

	it("is the reranker alone at 0.005: 53% about, 8% with a wrong extra entry, 5% unrelated and 70% cross-language", () => {
		const alone = { min: 0.005, wordMin: 0.005 };
		expect(
			measure((score, mentioned) =>
				earlierJoins(score, () => mentioned, alone),
			),
		).toEqual({ about: 46, extra: 7, unrelated: 2, cross: 7 });
	});
});
