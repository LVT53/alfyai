import type { MemoryScope } from "$lib/memory-types";

/**
 * What a link from Workspace Search names in the address,
 * `/knowledge?tab=memory&memoryScope=…&memoryEntry=…&memoryQuery=…`: the scope
 * to open, the entry in it and the search that found it. These names are not
 * among the Documents tab's own (`q`, `sort`, `type` …), so the Memory tab opens.
 */
export interface MemoryLink {
	scope: MemoryScope;
	entryId: string | null;
	query: string;
}

const PROJECT_PREFIX = "project:";

/** The link an address carries, or null when it is not one (no `tab=memory`, or no readable scope). */
export function readMemoryLink(url: URL): MemoryLink | null {
	const params = url.searchParams;
	if (params.get("tab") !== "memory") return null;
	const scopeValue = params.get("memoryScope");
	let scope: MemoryScope | null = null;
	if (scopeValue === "personal") {
		scope = { kind: "personal" };
	} else if (
		scopeValue?.startsWith(PROJECT_PREFIX) &&
		scopeValue.length > PROJECT_PREFIX.length
	) {
		scope = {
			kind: "project",
			projectId: scopeValue.slice(PROJECT_PREFIX.length),
		};
	}
	if (!scope) return null;
	return {
		scope,
		entryId: params.get("memoryEntry") || null,
		query: params.get("memoryQuery") ?? "",
	};
}
