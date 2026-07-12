import {
	CAPABILITIES,
	type Capability,
} from "$lib/server/services/connections/registry";

// Shared type guard for a client-supplied capability string. Declared once here
// and imported by google/start, onedrive/start, and cloud-warning (which each
// used to redeclare it byte-for-byte).
export function isCapability(value: unknown): value is Capability {
	return (
		typeof value === "string" &&
		(CAPABILITIES as readonly string[]).includes(value)
	);
}
