/**
 * The Earlier gate's blind measurement (label migration review, F5): the
 * messages in `earlier-blind-messages.json` were written by an agent that
 * never saw the rule, against part 2's extracted facts, and are measured once,
 * after the rule was frozen. Synthetic only.
 *
 * The bank is every config-2 personal fact part 2 extracted (its question,
 * brainstorm, lasting, ongoing and temporary statements; the project bank's
 * facts are left out), weighed with `mentionBank` as recall weighs a bank.
 * Every temporary and ongoing fact is an Earlier entry, and the worst case for
 * rank is assumed: every Earlier entry is in its bank's top three for every
 * message, so the gate is the mention alone. Writes counts and ids only.
 *
 *   export PATH=/opt/homebrew/opt/node@22/bin:$PATH
 *   npx svelte-kit sync
 *   node --import tsx docs/plans/hindsight-memory/label-migration-acceptance/earlier-blind.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	mentionBank,
	mentionsMemoryEntry,
	mentionWords,
} from "../../../../src/lib/server/services/memory-context/earlier-mention";

const HERE = dirname(fileURLToPath(import.meta.url));
type Lang = "en" | "hu";
interface Pointed {
	factKey: string;
	factIndex: number;
	lang: Lang;
	message: string;
}
const blind: {
	about: Pointed[];
	unrelated: { lang: Lang; message: string }[];
	crossLanguage: Pointed[];
} = JSON.parse(readFileSync(join(HERE, "earlier-blind-messages.json"), "utf8"));
const raw: Record<string, { facts: { text: string }[] }> = JSON.parse(
	readFileSync(
		join(HERE, "../part-2-acceptance/results/extraction-raw.json"),
		"utf8",
	),
);

const factId = (key: string, index: number) => `${key}#${index}`;
const personal = Object.entries(raw).flatMap(([key, { facts }]) =>
	key.startsWith("v2:") && !key.startsWith("v2:project:")
		? facts.map((fact, index) => ({ id: factId(key, index), key, text: fact.text }))
		: [],
);
const earlier = personal.filter(
	({ key }) =>
		key.startsWith("v2:temporary:") || key.startsWith("v2:ongoing:"),
);
const bank = mentionBank(personal.map(({ text }) => text));
const byId = new Map(earlier.map((entry) => [entry.id, entry]));
const brought = (message: string) => {
	const words = mentionWords(message);
	return earlier
		.filter(({ text }) => mentionsMemoryEntry(words, text, bank))
		.map(({ id }) => id);
};
const share = (part: number, whole: number) =>
	whole ? Math.round((part / whole) * 1000) / 1000 : null;

function pointed(items: Pointed[]) {
	const rows = items.map((item, index) => {
		const own = factId(item.factKey, item.factIndex);
		if (!byId.has(own)) throw new Error(`not an Earlier entry: ${own}`);
		const reached = brought(item.message);
		return {
			index,
			lang: item.lang,
			own,
			found: reached.includes(own),
			others: reached.filter((id) => id !== own),
		};
	});
	const lang = (code: Lang) => {
		const mine = rows.filter((row) => row.lang === code);
		return {
			messages: mine.length,
			brought: mine.filter((row) => row.found).length,
		};
	};
	const found = rows.filter((row) => row.found).length;
	return {
		messages: rows.length,
		brought: found,
		rate: share(found, rows.length),
		en: lang("en"),
		hu: lang("hu"),
		missed: rows
			.filter((row) => !row.found)
			.map(({ index, own }) => ({ message: index, entry: own })),
		alsoBrought: rows
			.filter((row) => row.others.length)
			.map(({ index, others }) => ({ message: index, entries: others })),
	};
}

const unrelatedRows = blind.unrelated.map((item, index) => ({
	index,
	lang: item.lang,
	entries: brought(item.message),
}));
const unrelatedLang = (code: Lang) => {
	const mine = unrelatedRows.filter((row) => row.lang === code);
	return {
		messages: mine.length,
		bringing: mine.filter((row) => row.entries.length).length,
	};
};
const bringing = unrelatedRows.filter((row) => row.entries.length).length;
const results = {
	bank: {
		source: "part-2-acceptance/results/extraction-raw.json (config 2, personal)",
		facts: personal.length,
		earlierEntries: earlier.length,
	},
	about: pointed(blind.about),
	unrelated: {
		messages: unrelatedRows.length,
		bringing,
		rate: share(bringing, unrelatedRows.length),
		en: unrelatedLang("en"),
		hu: unrelatedLang("hu"),
		falseMatches: unrelatedRows
			.filter((row) => row.entries.length)
			.map(({ index, entries }) => ({ message: index, entries })),
	},
	crossLanguage: pointed(blind.crossLanguage),
};
writeFileSync(
	join(HERE, "earlier-blind-results.json"),
	`${JSON.stringify(results, null, "\t")}\n`,
);
console.log(
	JSON.stringify({
		bank: results.bank,
		about: [results.about.brought, results.about.messages, results.about.rate],
		aboutEn: results.about.en,
		aboutHu: results.about.hu,
		aboutAlsoBrought: results.about.alsoBrought.length,
		unrelated: [bringing, unrelatedRows.length, results.unrelated.rate],
		unrelatedEn: results.unrelated.en,
		unrelatedHu: results.unrelated.hu,
		crossLanguage: [
			results.crossLanguage.brought,
			results.crossLanguage.messages,
			results.crossLanguage.rate,
		],
	}),
);
