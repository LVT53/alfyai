import { createHash } from "node:crypto";

export const bikeNameKey = (id: string) =>
	createHash("sha256").update(id).digest("hex");

export function savedBikeName(
	config: Record<string, unknown>,
	id: string | null,
) {
	const names = config.bikeNames;
	if (!id || !names || typeof names !== "object") return null;
	const key = bikeNameKey(id);
	const value = Object.getOwnPropertyDescriptor(names, key)?.value;
	return typeof value === "string" && value.length > 0 ? value : null;
}
