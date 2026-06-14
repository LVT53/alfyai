/**
 * Shared internal helpers for client API modules.
 * These are private to the api package — not part of the public surface.
 */

/**
 * Extract an array field from a response payload, returning an empty array
 * if the field is missing or not an array.
 *
 * @param response - The parsed JSON response object
 * @param key - The key to extract from the response
 */
export function _unwrapList<T>(response: unknown, key: string): T[] {
	if (typeof response !== "object" || response === null) return [];
	const payload = response as Record<string, unknown>;
	return Array.isArray(payload[key]) ? (payload[key] as T[]) : [];
}
