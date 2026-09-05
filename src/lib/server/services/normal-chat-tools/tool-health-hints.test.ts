import { describe, expect, it } from "vitest";

import type { ToolHealthSnapshot } from "$lib/server/services/tool-health";
import {
	applyDegradedToolHints,
	collectDegradedToolHints,
} from "./tool-health-hints";

function snapshot(
	tools: Array<{ tool: string; backend: string; status: string }>,
): ToolHealthSnapshot {
	return {
		checkedAt: "2026-09-05T12:00:00.000Z",
		durationMs: 1,
		tools: tools.map((entry, index) => ({
			id: `${entry.tool}:${index}`,
			tool: entry.tool,
			backend: entry.backend,
			status: entry.status as never,
			configured: true,
			probed: true,
			latencyMs: 10,
			detail: null,
			connectedConnections: null,
			checkedAt: "2026-09-05T12:00:00.000Z",
			degradedSince:
				entry.status === "degraded" ? "2026-09-05T11:00:00.000Z" : null,
		})),
	};
}

describe("degraded tool hints", () => {
	it("collects one hint per degraded tool, merging sub-backends", () => {
		const hints = collectDegradedToolHints(
			snapshot([
				{ tool: "research_web", backend: "Parallel", status: "healthy" },
				{ tool: "map_route", backend: "OpenRouteService", status: "degraded" },
				{ tool: "map_route", backend: "Nominatim", status: "degraded" },
				{ tool: "produce_file", backend: "Docker", status: "unconfigured" },
			]),
			"en",
		);
		expect([...hints.keys()]).toEqual(["map_route"]);
		expect(hints.get("map_route")).toContain("OpenRouteService, Nominatim");
		expect(hints.get("map_route")).toContain("degraded");
	});

	it("returns no hints without a snapshot", () => {
		expect(collectDegradedToolHints(null, "en").size).toBe(0);
	});

	it("appends hints to matching tool descriptions without mutating the input", () => {
		const tools = {
			map_route: { description: "Route things." },
			research_web: { description: "Search." },
		};
		const hints = collectDegradedToolHints(
			snapshot([
				{ tool: "map_route", backend: "OpenRouteService", status: "degraded" },
			]),
			"hu",
		);
		const next = applyDegradedToolHints(tools, hints);
		expect(next.map_route.description).toMatch(/^Route things\. FIGYELEM/);
		expect(next.research_web).toBe(tools.research_web);
		expect(tools.map_route.description).toBe("Route things.");
	});
});
