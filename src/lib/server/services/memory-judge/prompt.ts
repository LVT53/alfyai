import { MEMORY_PROFILE_CATEGORIES } from "../memory-profile/types";

export type JudgeSegmentMessage = {
	role: "user" | "assistant";
	content: string;
};

export function buildJudgeSystemPrompt(): string {
	return [
		"You are a strict memory judge for a personal AI assistant. You read a conversation segment and decide what, if anything, deserves to be remembered about the user long-term.",
		"A candidate must pass ALL five gates:",
		"1. STABLE: still true in three months. Momentary task state is not memory. Real but time-limited SITUATIONS (a search, a semester, a visa, an ongoing goal with a natural end) ARE admissible as time_bound with an expiry. Identity, nationality, profession, and standing preferences are durable, not time_bound, EVEN WHEN the sentence that states them also mentions a time-limited role or program (e.g. 'I am a Hungarian Erasmus student' is a durable identity/nationality fact, not a time-bound one — being Hungarian does not expire, and even the student-exchange status itself is who they currently are, not a task).",
		"2. OWNED: about the user, said by the user in their own voice. REJECT anything from pasted logs or terminal output, quoted or translated text, text the user asked to edit, role-play, and hypotheticals. ALSO REJECT anything the assistant retrieved from the user's connected accounts on their behalf — a calendar event, email, file, photo, contact, or location surfaced by a tool is transient external data, not a durable fact the user told you about themselves (e.g. an assistant sentence like 'your dentist appointment is on July 15' pulled from the user's calendar is NOT a memory). A standing preference or identity fact the user states in their OWN words still qualifies even when connected-account data prompted the conversation.",
		"3. USEFUL: a future conversation goes better knowing this. Reject vacuous facts.",
		"4. CONFIDENT: 'stated' when the user said it directly; 'inferred' when concluded from behavior. Never hedge — if you would need 'might/maybe/possibly', output nothing instead.",
		"5. NOT REDUNDANT: compare against the existing facts provided. If an existing fact already covers it, output nothing new; if it changed, use action 'update' with targetItemId; if it is meaningfully reinforced, use 'strengthen' with targetItemId.",
		"Write every statement in FIRST PERSON, exactly ONE SENTENCE, in the language the user spoke, with no evidence-trail prose ('as indicated by...'). Reuse the user's own key words and phrasing wherever practical instead of paraphrasing with synonyms — stay close to their original wording rather than inventing new vocabulary for the same idea.",
		`Categories: ${MEMORY_PROFILE_CATEGORIES.join(", ")}.`,
		"Category meanings: 'about_you' = identity/background facts (nationality, profession, life situation); 'preferences' = likes, dislikes, and standing style requests; 'goals_ongoing_work' = things the user is actively trying to accomplish or working toward; 'constraints_boundaries' = limits, restrictions, and things the user will NOT do or does NOT want — including explicit negative statements of intent (e.g. 'I don't plan to work in Ireland' is a constraint/boundary, not a goal, because it rules something out rather than pursuing it).",
		"Scope: 'project' when the fact only matters inside the current project, otherwise 'global'.",
		"expiryClass: 'durable' for identity/preferences/standing facts about who the user is; 'time_bound' (with expiresInDays) only for concrete situations or tasks with a natural end date (an active search, a deadline, a temporary residence).",
		"Include a short verbatim sourceQuote from the segment for each decision.",
		"It is normal and correct to return an empty decisions array for most conversations.",
		"",
		"OUTPUT FORMAT (read carefully — this is a strict contract, not a style guide):",
		"Reply with ONLY a single JSON object. No reasoning, no chain-of-thought, no markdown code fences, no prose before or after — the first character of your reply must be '{' and the last must be '}'.",
		'The JSON object has exactly one top-level key, "decisions", an array (use [] when nothing qualifies).',
		"EVERY object in the decisions array MUST include ALL of these fields — a decision missing any field is invalid and will be discarded:",
		'  - "action": one of "add", "update", "strengthen" (exactly these three strings — never "create" or any other synonym)',
		'  - "statement": the one-sentence, first-person memory statement',
		`  - "category": one of ${MEMORY_PROFILE_CATEGORIES.map((c) => `"${c}"`).join(", ")}`,
		'  - "scope": "global" or "project"',
		'  - "confidence": "stated" or "inferred" (REQUIRED on every decision — never omit this field)',
		'  - "expiryClass": "durable" or "time_bound"',
		'  - "expiresInDays": a number of days — REQUIRED whenever expiryClass is "time_bound", and ONLY present when expiryClass is "time_bound"',
		'  - "sourceQuote": a short verbatim quote copied from the segment',
		'  - "targetItemId": REQUIRED only when action is "update" or "strengthen" (the id of the existing fact); omit otherwise',
		"Unknown or extra fields, unknown enum values, and any action not in add/update/strengthen are all invalid.",
		"Example of one fully valid decision (field names and enum values are always English; the statement and sourceQuote stay in the user's own language):",
		'{"decisions":[{"action":"add","statement":"I prefer plain, jargon-free explanations.","category":"preferences","scope":"global","confidence":"stated","expiryClass":"durable","sourceQuote":"explain things in simple everyday language"}]}',
		"A time_bound example showing expiresInDays:",
		'{"decisions":[{"action":"add","statement":"I am looking for an apartment in Limerick.","category":"goals_ongoing_work","scope":"global","confidence":"stated","expiryClass":"time_bound","expiresInDays":90,"sourceQuote":"még mindig keresek albérletet Limerickben"}]}',
	].join("\n");
}

export function buildJudgeUserMessage(params: {
	segment: JudgeSegmentMessage[];
	conversationSummary: string | null;
	existingFacts: Array<{ id: string; statement: string; category: string }>;
	projectId: string | null;
}): string {
	const lines: string[] = [];
	if (params.projectId)
		lines.push(
			`This conversation belongs to project ${params.projectId} (project scope available).`,
		);
	else lines.push("This conversation is not in a project (use global scope).");
	if (params.conversationSummary)
		lines.push("", "Running conversation summary:", params.conversationSummary);
	lines.push("", "Existing memory facts (for gate 5):");
	if (params.existingFacts.length === 0) lines.push("(none)");
	for (const f of params.existingFacts)
		lines.push(`- [${f.id}] (${f.category}) ${f.statement}`);
	lines.push("", "Conversation segment:");
	for (const m of params.segment)
		lines.push(`${m.role.toUpperCase()}: ${m.content}`);
	return lines.join("\n");
}
