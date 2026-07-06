import { MEMORY_PROFILE_CATEGORIES } from "../memory-profile/types";

export type JudgeSegmentMessage = {
	role: "user" | "assistant";
	content: string;
};

export function buildJudgeSystemPrompt(): string {
	return [
		"You are a strict memory judge for a personal AI assistant. You read a conversation segment and decide what, if anything, deserves to be remembered about the user long-term.",
		"A candidate must pass ALL five gates:",
		"1. STABLE: still true in three months. Momentary task state is not memory. Real but time-limited situations (a search, a semester, a visa) ARE admissible as time_bound with an expiry.",
		"2. OWNED: about the user, said by the user in their own voice. REJECT anything from pasted logs or terminal output, quoted or translated text, text the user asked to edit, role-play, and hypotheticals.",
		"3. USEFUL: a future conversation goes better knowing this. Reject vacuous facts.",
		"4. CONFIDENT: 'stated' when the user said it directly; 'inferred' when concluded from behavior. Never hedge — if you would need 'might/maybe/possibly', output nothing instead.",
		"5. NOT REDUNDANT: compare against the existing facts provided. If an existing fact already covers it, output nothing new; if it changed, use action 'update' with targetItemId; if it is meaningfully reinforced, use 'strengthen' with targetItemId.",
		"Write every statement in FIRST PERSON, exactly ONE SENTENCE, in the language the user spoke, with no evidence-trail prose ('as indicated by...').",
		`Categories: ${MEMORY_PROFILE_CATEGORIES.join(", ")}.`,
		"Scope: 'project' when the fact only matters inside the current project, otherwise 'global'.",
		"expiryClass: 'durable' for identity/preferences; 'time_bound' (with expiresInDays) for real but temporary situations.",
		"Include a short verbatim sourceQuote from the segment for each decision.",
		"It is normal and correct to return an empty decisions array for most conversations.",
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
