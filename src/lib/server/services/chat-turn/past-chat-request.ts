// This recognizes explicit retrieval requests in the current author's prose.
// It does not classify the language of the reply.
const ENGLISH_CHAT =
	/\b(?:(?:old|older|recent|past|prior|previous|earlier|last|other|another)\s+(?:project\s+)?(?:chats?|conversations?|discussions?)|chat history|(?:chats?|conversations?|discussions?)\s+(?:from\s+|we had\s+)?(?:yesterday|last\s+(?:week|month|year))|(?:the|our|my)\s+(?:chats?|conversations?|discussions?)\s+(?:where|when|in which|about|titled|named|called))\b/u;
const ENGLISH_LOOKUP_PREFIX =
	/^(?:(?:please\s+)?(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:search|look(?:\s+(?:back|up|through|in|for))?|find|pull\s+up|bring\s+up|go\s+back|read|show(?:\s+me)?|open|check|review|summari[sz]e|revisit|use)(?:\s+(?:in|through|up|back|at|on|to|over|within|into|the|my|our|a|an|any|all|some|that|project['’]s))*$/u;
const ENGLISH_QUERY_LOOKUP_PREFIX =
	/^(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:search|look for|find)\b.{1,160}\b(?:in|through)\s*(?:(?:my|our|the)\s*)?$/u;
const ENGLISH_REPORTED_DISCUSSION =
	/^(?:(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:tell|remind)\s+me\s+|do\s+you\s+remember\s+|(?:please\s+)?(?:tell|remind)\s+me\s+|please\s+)?(?:(?:(?:what|where|when)\s+)?(?:did\s+(?:i|we|you)|(?:what|where|when)\s+(?:i|we|you))\s+(?:say|said|tell|told|write|wrote|talk(?:ed)?|discuss(?:ed)?|decide(?:d)?|agree(?:d)?|mention(?:ed)?|recommend(?:ed)?|ask(?:ed)?|suggest(?:ed)?|plan(?:ned)?|choose|chose)\b|(?:what|when)\s+(?:was|were)\b.*\b(?:said|discussed|agreed|decided|mentioned|title)\b|which\s+(?:(?:old|past|earlier|previous)\s+)?(?:chats?|conversations?|discussions?)\b)/u;
const ENGLISH_PROJECT_DECISION =
	/^(?:(?:can|could|would|will)\s+you\s+tell\s+me\s+)?what\s+did\s+(?:i|we)\s+(?:decide|discuss|agree(?:\s+on)?)\b.*\bin\s+(?:[a-z0-9_-]+\s+){0,4}project\b/u;

const HUNGARIAN_CHAT =
	/\b(?:(?:korabbi|regebbi|regi|elozo|multkori|tegnapi|masik|mult\s+heti)\s+(?:projekt\w*\s+)?(?:beszelget\w*|cset\w*|chat\w*)|beszelgetesi\s+elozmeny\w*|(?:beszelget\w*|cset\w*|chat\w*)\s+(?:amikor|amelyikben|ahol))\b/u;
const HUNGARIAN_LOOKUP_PREFIX =
	/^(?:kerlek\s+)?(?:(?:meg\s+tudn[a-z]+\s+)(?:nezni|keresni|mutatni|nyitni)|keres[ds]\w*|keress\w*|keresnel|megkeres\w*|nezz\w*|nezd\w*|megnezn\w*|visszanezn\w*|mutas[ds]\w*|megmutat\w*|nyisd\w*|olvas[ds]\w*|osszefoglal\w*|foglal\w*\s+ossze|idezd\w*)(?:\s+(?:a|az|egy|meg|vissza|projekt\w*))*$/u;
const HUNGARIAN_REPORTED_DISCUSSION =
	/^(?:kerlek\s+)?(?:(?:el\s+tud(?:od|nad)\s+mondani|mondd\s+el|emlekszel(?:\s+ra)?),?\s+)?(?:(?:mit|mirol|hol|mikor|miben)\s+(?:mond\w*|beszelt\w*|irt\w*|emlit\w*|dont\w*|allapod\w*|kerdez\w*)\b|melyik\s+(?:(?:korabbi|regi|elozo)\s+)?(?:beszelget\w*|cset\w*|chat\w*)\b|mi\s+volt\b.*\b(?:cime|megbeszelt\w*|dontes\w*)\b)/u;
const HUNGARIAN_NAMED_CHAT =
	/^(?:kerlek\s+)?(?:nyisd\s+meg|keresd\s+meg|mutasd\s+meg|nezd\s+meg)\s+.{0,100}\bcimu\s+(?:beszelgetest|csetet|chatet)\b/u;
const HUNGARIAN_PROJECT_DECISION =
	/^(?:mit|miben)\s+(?:donto\w*|beszelt\w*|allapodt\w*)\b.*\bprojektben\b/u;

const CURRENT_CHAT_ONLY =
	/\b(?:only (?:in|from|use) this (?:chat|conversation)|this (?:chat|conversation) only|just now|az iment|csak (?:ebben|e) a (?:beszelget\w*|cset\w*|chat\w*))\b/u;
const LOOKUP_EXCLUSION =
	/\b(?:without (?:searching|looking|reading|checking)|(?:do not|don't|never)\s+(?:search|look|read|open|check|use)|anelkul,?\s+hogy|ne\s+(?:keress|nezz|olvass))\b/u;

export function requestsPastChatLookup(
	requestText?: string,
	currentProjectName?: string,
): boolean {
	if (!requestText || requestText.length > 8_000) return false;
	const prose = requestText
		.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, " ")
		.replace(/^\s*>[^\r\n]*/gmu, " ")
		.replace(
			/`[^`\r\n]*`|"[^"]*(?:"|$)|“[^”]*(?:”|$)|„[^”]*(?:”|$)|«[^»]*(?:»|$)|(?<![\p{L}\p{N}])'[^'\r\n]+'(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])[‘’](?:[^’]|’(?=[\p{L}\p{N}]))*’(?![\p{L}\p{N}])/gu,
			" ",
		)
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.replace(/’/gu, "'")
		.toLowerCase();
	if (CURRENT_CHAT_ONLY.test(prose)) return false;

	const clauses = prose
		.split(/[.!?;\r\n]+/u)
		.map((part) => part.trim().replace(/^(please|kerlek),\s*/u, "$1 "));
	// A prohibition on retrieving the named source wins even if a later
	// clause refers to it while asking about a current fact.
	if (
		clauses.some(
			(clause) =>
				LOOKUP_EXCLUSION.test(clause) &&
				(ENGLISH_CHAT.test(clause) || HUNGARIAN_CHAT.test(clause)),
		)
	)
		return false;

	const currentProject = currentProjectName
		?.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.trim();
	return clauses.some((clause) => {
		if (
			currentProject !== undefined &&
			(!currentProject ||
				(!clause.endsWith(` in ${currentProject}`) &&
					!clause.endsWith(` in the ${currentProject}`) &&
					!clause.endsWith(` a ${currentProject} projektben`) &&
					!/\b(?:this project's (?:past|previous|earlier) (?:chats|conversations|discussions)|(?:a|ennek a) projekt(?:nek a)? (?:korabbi|elozo|regi) beszelget\w*)\b/u.test(
						clause,
					)))
		)
			return false;
		const english = ENGLISH_CHAT.exec(clause);
		const hungarian = HUNGARIAN_CHAT.exec(clause);
		return (
			(english !== null &&
				(ENGLISH_LOOKUP_PREFIX.test(clause.slice(0, english.index).trimEnd()) ||
					ENGLISH_QUERY_LOOKUP_PREFIX.test(clause.slice(0, english.index)) ||
					(ENGLISH_REPORTED_DISCUSSION.test(clause) &&
						(/\b(?:in|from|of)\b(?:\s+[a-z'’]+){0,5}\s*$/u.test(
							clause.slice(0, english.index),
						) ||
							/^which\b/u.test(clause))))) ||
			ENGLISH_PROJECT_DECISION.test(clause) ||
			(hungarian !== null &&
				(HUNGARIAN_LOOKUP_PREFIX.test(
					clause.slice(0, hungarian.index).trimEnd(),
				) ||
					(HUNGARIAN_REPORTED_DISCUSSION.test(clause) &&
						(/(?:ban|ben|bol)\b/u.test(hungarian[0]) ||
							/^melyik\b/u.test(clause))))) ||
			HUNGARIAN_PROJECT_DECISION.test(clause) ||
			HUNGARIAN_NAMED_CHAT.test(clause)
		);
	});
}
