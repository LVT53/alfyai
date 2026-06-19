import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import {
	getHonchoAssistantPeerId,
	getHonchoUserPeerId,
} from "../honcho-identifiers";

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
	honchoPeerVersion: number;
}): MemoryProfileTextSanitizer {
	const replacement = params.displayName.trim() || "the user";
	const candidateIds = new Set<string>([
		params.userId,
		getHonchoUserPeerId(params.userId, params.honchoPeerVersion),
		getHonchoAssistantPeerId(params.userId, params.honchoPeerVersion),
		getHonchoUserPeerId(params.userId, 0),
		getHonchoAssistantPeerId(params.userId, 0),
	]);
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
	honchoPeerVersion: number;
}> {
	const [user] = await db
		.select({
			name: users.name,
			honchoPeerVersion: users.honchoPeerVersion,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return {
		displayName: user?.name?.trim() || "the user",
		honchoPeerVersion: user?.honchoPeerVersion ?? 0,
	};
}
