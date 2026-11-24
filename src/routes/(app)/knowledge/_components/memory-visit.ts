import type { MemoryScope } from "$lib/memory-types";
/** SvelteKit per-history-entry snapshot. Never includes memory text or a draft. */
export interface MemoryVisit {
	detached?: NonNullable<MemoryVisit["pending"]>[];
	scopeValue: string;
	/** The subject opened on the subject index, or every Earlier entry (`all`). */
	subject?: string | null;
	query: string;
	pages: number;
	rowId: string;
	scrollTop: number;
	pending: {
		requestId: string;
		operationId: string | null;
		kind: "add" | "edit" | "remove";
		scope: MemoryScope;
		rowId: string | null;
	} | null;
}
