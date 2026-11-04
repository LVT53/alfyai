// Deterministic, JSON-shaped serialization: object keys sorted, arrays in
// their existing order, JSON scalars. It lives in its own module so the tool
// envelope's token ceiling (`model-payload-budget.ts`) can measure a payload
// the same way the rest of the tool layer does without importing `shared.ts`
// back — `shared.ts` imports the ceiling, so that would be a cycle.
export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}
