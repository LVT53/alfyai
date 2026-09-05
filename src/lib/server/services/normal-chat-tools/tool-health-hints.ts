// Degraded-backend hints for tool descriptions.
//
// The tool-health registry probes every backend on a timer (see
// services/tool-health). Rather than silently dropping a tool whose backend
// is failing — which would hide the problem from the model AND the user —
// we keep it registered and append an honest note to its description, so the
// model expects failures and says so instead of pretending. Only the cached
// snapshot is consulted (no probes on the request path).

import type { ToolHealthSnapshot } from "$lib/server/services/tool-health";

type ToolLike = { description?: string };

export function collectDegradedToolHints(
	snapshot: ToolHealthSnapshot | null,
	lang: "en" | "hu",
): Map<string, string> {
	const hints = new Map<string, string>();
	if (!snapshot) return hints;
	const backendsByTool = new Map<string, string[]>();
	for (const report of snapshot.tools) {
		if (report.status !== "degraded") continue;
		const list = backendsByTool.get(report.tool) ?? [];
		list.push(report.backend);
		backendsByTool.set(report.tool, list);
	}
	for (const [tool, backends] of backendsByTool) {
		const joined = backends.join(", ");
		hints.set(
			tool,
			lang === "hu"
				? `FIGYELEM: az eszköz háttérszolgáltatása (${joined}) jelenleg hibásként van jelentve. Ha a hívás sikertelen, mondd ki egyértelműen, és ne tégy úgy, mintha sikerült volna.`
				: `NOTE: this tool's backend (${joined}) is currently reported as degraded. If the call fails, say so plainly and do not pretend it succeeded.`,
		);
	}
	return hints;
}

export function applyDegradedToolHints<T extends Record<string, ToolLike>>(
	tools: T,
	hints: Map<string, string>,
): T {
	if (hints.size === 0) return tools;
	const next: Record<string, ToolLike> = { ...tools };
	for (const [name, hint] of hints) {
		const entry = next[name];
		if (!entry || typeof entry.description !== "string") continue;
		next[name] = { ...entry, description: `${entry.description} ${hint}` };
	}
	return next as T;
}
