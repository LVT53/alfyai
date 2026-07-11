import { listProjectionPolicyBlockedStatements } from "$lib/server/services/memory-profile/active-context";

export type ProjectionPolicyBlockedStatement = Awaited<
	ReturnType<typeof listProjectionPolicyBlockedStatements>
>[number];

// Minimum normalized length before a blocked statement is allowed to match
// screened content. Short statements ("bike") would cause false-positive
// blocking of unrelated conversations, so we require enough signal.
const POLICY_MIN_STATEMENT_CHARS = 12;

export function normalizeMemoryPolicyText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function screenContentAgainstProjectionPolicy(params: {
	blockedStatements: ProjectionPolicyBlockedStatement[];
	content: string | null;
}): {
	blocked: boolean;
	blockedCount: number;
	unresolvedStatuses: string[];
} {
	const normalizedContent = normalizeMemoryPolicyText(params.content ?? "");
	if (!normalizedContent) {
		return { blocked: false, blockedCount: 0, unresolvedStatuses: [] };
	}

	let blockedCount = 0;
	const unresolvedStatuses = new Set<string>();
	for (const statement of params.blockedStatements) {
		const normalizedStatement = normalizeMemoryPolicyText(statement.statement);
		if (
			normalizedStatement.length >= POLICY_MIN_STATEMENT_CHARS &&
			normalizedContent.includes(normalizedStatement)
		) {
			if (statement.status === "deleted" || statement.status === "suppressed") {
				blockedCount += 1;
			} else {
				unresolvedStatuses.add(statement.status);
			}
		}
	}
	return {
		blocked: blockedCount > 0,
		blockedCount,
		unresolvedStatuses: Array.from(unresolvedStatuses).sort(),
	};
}

type PolicyScreenableMessage = {
	content: string;
	attachments?: Array<{ content: string }>;
};

export function buildHistoryPolicyContent(conversation: {
	title: string;
	summary: string | null;
	messageSnippets: Array<{ content: string }>;
	messages?: PolicyScreenableMessage[];
}): string {
	return [
		conversation.title,
		conversation.summary,
		...conversation.messageSnippets.map((message) => message.content),
		...(conversation.messages ?? []).map((message) =>
			[
				message.content,
				...(message.attachments ?? []).map((attachment) => attachment.content),
			]
				.filter(Boolean)
				.join(" "),
		),
	]
		.filter(Boolean)
		.join(" ");
}

export { listProjectionPolicyBlockedStatements };
