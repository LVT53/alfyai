import { describe, expect, it } from "vitest";
import {
	areNearDuplicateArtifactTexts,
	prefersWorkflowEvidence,
} from "./evidence-family";

describe("evidence family helpers", () => {
	it("treats whitespace-normalized text matches as near duplicates", () => {
		expect(
			areNearDuplicateArtifactTexts(
				"This is a structured analysis of the uploaded resume.",
				"  this is a structured   analysis of the uploaded resume.  ",
			),
		).toBe(true);
	});

	it("keeps moderately rewritten follow-up outputs out of the duplicate bucket", () => {
		const base =
			"The job description emphasizes stakeholder communication, cross-functional coordination, measurable improvements across product and operations teams, clear ownership of delivery milestones, careful risk tracking, written updates for leadership, and consistent collaboration with recruiting and hiring managers.";
		const followUp =
			"The job description emphasizes stakeholder communication, cross-functional coordination, measurable improvements across product and operations teams, clear ownership of delivery milestones, careful issue tracking, written updates for leadership, and consistent collaboration with recruiting and hiring managers.";

		expect(areNearDuplicateArtifactTexts(base, followUp)).toBe(false);
	});

	it("keeps materially different outputs out of the duplicate bucket", () => {
		expect(
			areNearDuplicateArtifactTexts(
				"This answer summarizes the document and extracts hiring criteria.",
				"This answer reconstructs the timeline of previous workflow steps and compares them across chats.",
			),
		).toBe(false);
	});

	it("flags workflow- and history-oriented queries", () => {
		expect(
			prefersWorkflowEvidence(
				"Show me the previous draft history for this workflow",
			),
		).toBe(true);
		expect(
			prefersWorkflowEvidence(
				"What does this contract say about indemnification?",
			),
		).toBe(false);
	});
});
