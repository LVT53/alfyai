import type { NativeMemory } from "./contracts";
/** Compatibility formatting for the pinned native suffix only. Not semantic rewriting. */
export function splitNativeNotes(
	row: NativeMemory,
	sources: NativeMemory[],
): string {
	let current = row.text;
	const allowed = new Set(row.source_memory_ids ?? []);
	const suffixes = sources
		.filter(
			(f) =>
				allowed.has(f.id) && f.fact_type !== "observation" && f.mentioned_at,
		)
		.map(
			(f) =>
				`(${f.mentioned_at?.slice(0, 16).replace("T", " ")}: ${f.text.split(" | ")[0].trim()})`,
		);
	for (;;) {
		const suffix = suffixes.find((s) => current.endsWith(` ${s}`));
		if (!suffix) return current;
		current = current.slice(0, -suffix.length).trimEnd();
	}
}
