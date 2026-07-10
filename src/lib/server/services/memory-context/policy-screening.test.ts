import { describe, expect, it } from "vitest";
import {
	buildHistoryPolicyContent,
	screenContentAgainstProjectionPolicy,
} from "./policy-screening";

describe("projection-policy screening", () => {
	const blockedStatements = [
		{
			id: "b1",
			status: "suppressed" as const,
			statement: "Bike detail 2: compare commute setup and tire width.",
		},
		{
			id: "b2",
			status: "deleted" as const,
			statement: "The user moved away from the city center.",
		},
	];

	it("blocks content that echoes a deleted or suppressed statement", () => {
		const screen = screenContentAgainstProjectionPolicy({
			blockedStatements,
			content: "Bike detail 2: compare commute setup and tire width.",
		});
		expect(screen.blocked).toBe(true);
		expect(screen.blockedCount).toBe(1);
	});

	it("does not block on short (<12 normalized char) statement matches", () => {
		const screen = screenContentAgainstProjectionPolicy({
			blockedStatements: [{ id: "s", status: "deleted", statement: "bike" }],
			content: "bike notes and tire width",
		});
		expect(screen.blocked).toBe(false);
		expect(screen.blockedCount).toBe(0);
	});

	it("surfaces unresolved statuses without blocking", () => {
		const screen = screenContentAgainstProjectionPolicy({
			blockedStatements: [
				{
					id: "p",
					status: "review_needed",
					statement: "The user moved away from the city center.",
				},
			],
			content: "The user moved away from the city center.",
		});
		expect(screen.blocked).toBe(false);
		expect(screen.unresolvedStatuses).toEqual(["review_needed"]);
	});

	it("returns not-blocked for empty content", () => {
		const screen = screenContentAgainstProjectionPolicy({
			blockedStatements,
			content: null,
		});
		expect(screen.blocked).toBe(false);
	});

	it("builds screenable content from title, summary and snippets", () => {
		const content = buildHistoryPolicyContent({
			title: "Bike chat",
			summary: "tire width",
			messageSnippets: [{ content: "commute setup" }],
		});
		expect(content).toContain("Bike chat");
		expect(content).toContain("tire width");
		expect(content).toContain("commute setup");
	});
});
