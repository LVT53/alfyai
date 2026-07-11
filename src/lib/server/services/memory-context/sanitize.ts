import {
	createIdentityTextSanitizer,
	type MemoryProfileTextSanitizer,
} from "$lib/server/services/memory-profile/identity-sanitizer";

/**
 * Build a DB-free sanitizer for memory-read output. Persona facts are already
 * scrubbed at the projection boundary (active-context), but history, project,
 * and the persona summary reach the model through this read path and must be
 * scrubbed uniformly. We derive identity from the caller-supplied display name
 * (falling back to "the user") plus the raw user id so the primary scrub — the
 * raw id and legacy internal peer-id patterns — works without a database round
 * trip on every read.
 */
export function buildMemoryReadSanitizer(params: {
	userId: string;
	userDisplayName?: string | null;
}): MemoryProfileTextSanitizer {
	return createIdentityTextSanitizer({
		userId: params.userId,
		displayName: params.userDisplayName?.trim() || "the user",
	});
}

export function sanitizeNullableText(
	value: string | null | undefined,
	sanitize: MemoryProfileTextSanitizer,
): string | null {
	if (value === null || value === undefined) return null;
	return sanitize(value);
}
