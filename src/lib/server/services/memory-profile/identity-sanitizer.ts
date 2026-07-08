import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";

export function sanitizePublicMemoryText(
	text: string,
	sanitizer: MemoryProfileTextSanitizer,
): string {
	return sanitizer(text);
}

export type MemoryProfileTextSanitizer = (text: string) => string;

export function createIdentityTextSanitizer(params: {
	userId: string;
	displayName: string;
}): MemoryProfileTextSanitizer {
	const replacement = params.displayName.trim() || "the user";
	const candidateIds = new Set<string>([params.userId]);
	// Legacy internal peer-id patterns (e.g. "U_abcd1234") may still linger in
	// older stored memory text; scrub them defensively.
	const broadLegacyPeerIdPattern = /\b[UuAa][_-][A-Za-z0-9_-]{8,}\b/g;

	return (text: string) => {
		let sanitized = text.trim();
		for (const candidateId of candidateIds) {
			if (!candidateId) continue;
			sanitized = sanitized.split(candidateId).join(replacement);
		}
		return sanitized
			.replace(broadLegacyPeerIdPattern, replacement)
			.replace(/\s+/g, " ")
			.trim();
	};
}

export async function getMemoryProfileIdentity(userId: string): Promise<{
	displayName: string;
}> {
	const [user] = await db
		.select({
			name: users.name,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return {
		displayName: user?.name?.trim() || "the user",
	};
}
