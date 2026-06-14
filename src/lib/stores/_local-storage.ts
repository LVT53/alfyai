/**
 * Shared localStorage helpers for client-side store modules.
 * Keeps storage access patterns consistent and guard-first.
 */

/**
 * Check whether localStorage is available in the current environment.
 */
export function canUseStorage(): boolean {
	return typeof window !== "undefined";
}

/**
 * Write a value to localStorage under the given key.
 * Silently no-ops when storage is unavailable.
 */
export function persist(key: string, value: string): void {
	if (canUseStorage()) {
		localStorage.setItem(key, value);
	}
}

/**
 * Read a value from localStorage, returning the fallback if absent or invalid.
 *
 * @param key - localStorage key
 * @param fallback - value to return when the key is missing or doesn't match the validator
 * @param isValid - optional validator; return true to accept the stored value
 */
export function read<T>(
	key: string,
	fallback: T,
	isValid?: (value: string) => value is T,
): T {
	if (!canUseStorage()) return fallback;

	const stored = localStorage.getItem(key);
	if (stored === null) return fallback;
	if (isValid) return isValid(stored) ? (stored as T) : fallback;
	return fallback;
}
