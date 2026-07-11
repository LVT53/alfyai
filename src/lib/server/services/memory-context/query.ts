import { or, type SQL, sql } from "drizzle-orm";

// Stopwords for account-history recall. English + Hungarian low-signal tokens
// that would otherwise flood the LIKE search with matches on filler words.
const HISTORY_QUERY_STOPWORDS = new Set([
	"a",
	"about",
	"all",
	"am",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"been",
	"but",
	"by",
	"can",
	"could",
	"did",
	"do",
	"does",
	"for",
	"from",
	"had",
	"has",
	"have",
	"how",
	"i",
	"in",
	"is",
	"it",
	"know",
	"me",
	"my",
	"of",
	"on",
	"or",
	"our",
	"please",
	"remember",
	"tell",
	"that",
	"the",
	"their",
	"them",
	"there",
	"this",
	"to",
	"was",
	"we",
	"what",
	"when",
	"where",
	"which",
	"who",
	"with",
	"would",
	"you",
	"your",
	"az",
	"egy",
	"és",
	"vagy",
	"hogy",
	"de",
	"ha",
	"akkor",
	"mert",
	"nem",
	"van",
	"volt",
	"lesz",
	"ezt",
	"azt",
	"itt",
	"ott",
	"nekem",
	"neki",
	"róla",
	"rola",
	"erről",
	"errol",
	"arról",
	"arrol",
	"kérlek",
	"kerlek",
	"tudsz",
	"tudnál",
	"tudnal",
	"mondd",
	"mondj",
	"mi",
	"mit",
	"milyen",
	"hogyan",
	"hol",
	"mikor",
	"melyik",
	"keress",
	"keres",
	"rá",
	"ra",
]);

export function tokenizeQuery(query: string): string[] {
	return Array.from(
		new Set(
			(query.toLowerCase().match(/[\p{L}\p{N}%_\\]+/giu) ?? []).filter(
				(term) =>
					/[\p{L}\p{N}]/iu.test(term) &&
					term.length >= 2 &&
					!HISTORY_QUERY_STOPWORDS.has(term),
			),
		),
	);
}

export function escapeHistoryLikeTerm(term: string): string {
	return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function scoreHistoryText(terms: string[], text: string): number {
	if (terms.length === 0) return 1;
	const normalized = text.toLowerCase();
	return terms.reduce(
		(score, term) => score + (normalized.includes(term) ? 1 : 0),
		0,
	);
}

export function buildHistoryTermFilter(
	terms: string[],
	columns: SQL[],
): SQL | undefined {
	if (terms.length === 0) return undefined;
	const filters = terms.flatMap((term) => {
		const pattern = `%${escapeHistoryLikeTerm(term)}%`;
		return columns.map(
			(column) => sql`lower(${column}) like ${pattern} escape '\\'`,
		);
	});
	return or(...filters);
}
