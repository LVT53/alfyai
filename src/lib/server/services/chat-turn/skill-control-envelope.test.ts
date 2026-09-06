import { describe, expect, it } from "vitest";
import { parseSkillControlEnvelopeFromAssistantText } from "./skill-control-envelope";

describe("skill control envelopes", () => {
	it("keeps incomplete envelopes visible and does not guess operations", () => {
		const result = parseSkillControlEnvelopeFromAssistantText(
			[
				"Visible answer",
				"<skill_control_v1>",
				'{"version":1,"operations":[{"operationId":"partial"',
			].join("\n"),
		);

		expect(result.visibleText).toContain("<skill_control_v1>");
		expect(result.metadata).toBeUndefined();
		expect(result.operations).toEqual([]);
	});

	it("strips complete malformed envelopes without operations", () => {
		const result = parseSkillControlEnvelopeFromAssistantText(
			"Answer\n<skill_control_v1>\nnot-json\n</skill_control_v1>",
		);

		expect(result.visibleText).toBe("Answer");
		expect(result.operations).toEqual([]);
		expect(result.metadata).toMatchObject({
			skillControl: {
				malformedEnvelopeCount: 1,
				operations: [],
			},
		});
	});

	it("dedupes repeated operation ids inside complete envelopes", () => {
		const draft = {
			id: "draft-1",
			displayName: "Meeting critic",
			description: "Review meeting notes.",
			instructions: "Find missing owners.",
			activationExamples: [],
		};
		const payload = {
			version: 1,
			operations: [
				{ operationId: "same-op", kind: "skill_draft", draft },
				{
					operationId: "same-op",
					kind: "skill_draft",
					draft: { ...draft, displayName: "Ignored duplicate" },
				},
			],
		};
		const result = parseSkillControlEnvelopeFromAssistantText(
			`Done\n<skill_control_v1>\n${JSON.stringify(payload)}\n</skill_control_v1>`,
		);

		expect(result.operations).toHaveLength(1);
		expect(result.operations[0]).toMatchObject({
			operationId: "same-op",
			kind: "skill_draft",
			draft: expect.objectContaining({ displayName: "Meeting critic" }),
		});
	});

	it("parses Skill Draft proposals with conservative policy defaults", () => {
		const result = parseSkillControlEnvelopeFromAssistantText(
			[
				"I can make this reusable.",
				"<skill_control_v1>",
				JSON.stringify({
					version: 1,
					operations: [
						{
							operationId: "draft-op-1",
							kind: "skill_draft",
							draft: {
								id: "draft-1",
								displayName: "Meeting critic",
								description: "Review meeting notes for weak follow-ups.",
								instructions:
									"Find missing owners, vague deadlines, and risky assumptions.",
								activationExamples: ["review these meeting notes"],
							},
						},
					],
				}),
				"</skill_control_v1>",
			].join("\n"),
		);

		expect(result.visibleText).toBe("I can make this reusable.");
		expect(result.metadata?.skillDrafts).toEqual([
			{
				id: "draft-1",
				status: "proposed",
				displayName: "Meeting critic",
				description: "Review meeting notes for weak follow-ups.",
				instructions:
					"Find missing owners, vague deadlines, and risky assumptions.",
				activationExamples: ["review these meeting notes"],
				durationPolicy: "next_message",
				questionPolicy: "none",
				notesPolicy: "none",
				sourceScope: "selected_sources_only",
			},
		]);
		expect(result.operations).toEqual([
			{
				operationId: "draft-op-1",
				kind: "skill_draft",
				draft: expect.objectContaining({
					id: "draft-1",
					status: "proposed",
				}),
			},
		]);
	});

	it("strips malformed Skill Draft envelopes without recording proposals", () => {
		const result = parseSkillControlEnvelopeFromAssistantText(
			[
				"Visible answer",
				"<skill_control_v1>",
				JSON.stringify({
					version: 1,
					operations: [
						{
							operationId: "draft-op-1",
							kind: "skill_draft",
							draft: {
								id: "draft-1",
								displayName: "No instructions",
							},
						},
					],
				}),
				"</skill_control_v1>",
			].join("\n"),
		);

		expect(result.visibleText).toBe("Visible answer");
		expect(result.operations).toEqual([]);
		expect(result.metadata).toBeUndefined();
	});

	it("ignores operations with an unrecognized kind", () => {
		const result = parseSkillControlEnvelopeFromAssistantText(
			[
				"Visible answer",
				"<skill_control_v1>",
				JSON.stringify({
					version: 1,
					operations: [
						{
							operationId: "legacy-session-op",
							kind: "session_transition",
							transition: "awaiting_user",
						},
					],
				}),
				"</skill_control_v1>",
			].join("\n"),
		);

		expect(result.visibleText).toBe("Visible answer");
		expect(result.operations).toEqual([]);
		expect(result.metadata).toBeUndefined();
	});
});
