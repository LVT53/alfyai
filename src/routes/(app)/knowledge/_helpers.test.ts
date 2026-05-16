import { describe, expect, it } from "vitest";
import { normalizeKnowledgeMemoryOverviewBullets } from "./_helpers";

describe("normalizeKnowledgeMemoryOverviewBullets", () => {
	it("turns timestamped Honcho observations into separate human-readable bullets", () => {
		const bullets = normalizeKnowledgeMemoryOverviewBullets(
			"Explicit Observations [2026-04-25 23:15:33] Levi is enrolled in the Communication & Multimedia Design (CMDWLD) bachelor's programme at NHL Stenden University of Applied Sciences in Leeuwarden for the academic year 2024/2025. [2026-05-14 12:25:20] Levi owns an eBike that arrived on May 13, 2026 [2026-05-14 12:31:53] Levi is interested in comparing insurance options.",
		);

		expect(bullets).toEqual([
			"Levi is enrolled in the Communication & Multimedia Design (CMDWLD) bachelor's programme at NHL Stenden University of Applied Sciences in Leeuwarden for the academic year 2024/2025.",
			"Levi owns an eBike that arrived on May 13, 2026",
			"Levi is interested in comparing insurance options.",
		]);
		expect(bullets.join(" ")).not.toContain("[2026-");
		expect(bullets.join(" ")).not.toContain("Explicit Observations");
	});

	it("strips heading and markdown markers without losing concrete facts", () => {
		const bullets = normalizeKnowledgeMemoryOverviewBullets(
			"## Memory Overview\n- Levi has front-end and back-end development skills.\n- Levi owns a Cube Kathmandu and has asked about getting insurance for it.",
		);

		expect(bullets).toEqual([
			"Levi has front-end and back-end development skills.",
			"Levi owns a Cube Kathmandu and has asked about getting insurance for it.",
		]);
		expect(bullets.join(" ")).not.toContain("##");
	});

	it("softens obvious sensitive values without dropping useful memory bullets", () => {
		const bullets = normalizeKnowledgeMemoryOverviewBullets(
			[
				"[2026-04-25 23:30:15] Levi has a phone number of 0642919770.",
				"[2026-04-25 23:30:15] Levi uses contact email futuredesigncenter@nhlstenden.com when discussing the programme.",
				"[2026-04-25 23:30:15] Levi has token: abcdefghijklmnop for a test integration.",
			].join(" "),
		);

		expect(bullets).toEqual([
			"Levi has a phone number of [phone number].",
			"Levi uses contact email [email address] when discussing the programme.",
			"Levi has token: [redacted] for a test integration.",
		]);
	});

	it("caps the display list at forty bullets", () => {
		const source = Array.from(
			{ length: 45 },
			(_, index) =>
				`[2026-04-25 23:15:33] Levi has durable memory item ${index + 1}.`,
		).join(" ");

		const bullets = normalizeKnowledgeMemoryOverviewBullets(source);

		expect(bullets).toHaveLength(40);
		expect(bullets[0]).toBe("Levi has durable memory item 1.");
		expect(bullets[39]).toBe("Levi has durable memory item 40.");
	});
});
