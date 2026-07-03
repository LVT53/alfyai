/**
 * Pure helpers for the message composer character counter.
 *
 * Kept side-effect free so they can be unit-tested in isolation.
 * `MessageInput.svelte` wires these into its markup for the
 * always-visible counter (ADR-0043 Slice 10, Fix A).
 */

/**
 * Returns true when the current message length exceeds the configured
 * maximum, i.e. the message is too long to send.
 *
 * At exactly the limit the message is still submittable, so this returns
 * false. A max of 0 is treated as "no text allowed", which only over-length
 * for any non-empty current value.
 */
export function isOverLength(current: number, max: number): boolean {
	return current > max;
}
