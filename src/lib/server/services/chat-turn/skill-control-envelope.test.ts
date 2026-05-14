import { describe, expect, it } from "vitest";
import { parseSkillControlEnvelopeFromAssistantText } from "./skill-control-envelope";

describe("skill control envelopes", () => {
	it("strips a complete v1 envelope and returns validated operations", () => {
		const result = parseSkillControlEnvelopeFromAssistantText(
			[
				"Which deadline should I use?",
				"<skill_control_v1>",
				JSON.stringify({
					version: 1,
					operations: [
						{
							operationId: "turn-1-question",
							kind: "session_transition",
							transition: "awaiting_user",
						},
					],
				}),
				"</skill_control_v1>",
			].join("\n"),
		);

		expect(result.visibleText).toBe("Which deadline should I use?");
		expect(result.metadata).toMatchObject({
			skillQuestion: true,
			skillControl: {
				envelopeVersion: 1,
				operations: [
					{
						operationId: "turn-1-question",
						kind: "session_transition",
						transition: "awaiting_user",
					},
				],
			},
		});
		expect(result.operations).toHaveLength(1);
	});

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

	it("strips complete malformed envelopes without transitions", () => {
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
		const payload = {
			version: 1,
			operations: [
				{
					operationId: "same-op",
					kind: "session_transition",
					transition: "finished",
				},
				{
					operationId: "same-op",
					kind: "session_transition",
					transition: "dismissed",
				},
			],
		};
		const result = parseSkillControlEnvelopeFromAssistantText(
			`Done\n<skill_control_v1>\n${JSON.stringify(payload)}\n</skill_control_v1>`,
		);

		expect(result.operations).toEqual([
			{
				operationId: "same-op",
				kind: "session_transition",
				transition: "finished",
			},
		]);
	});

	it("records note operations as pending intents only", () => {
		const result = parseSkillControlEnvelopeFromAssistantText(
			[
				"I captured the decision.",
				"<skill_control_v1>",
				JSON.stringify({
					version: 1,
					operations: [
						{
							operationId: "note-intent-1",
							kind: "note_intent",
							action: "create",
							title: "Decision",
							body: "Use the shorter plan.",
						},
					],
				}),
				"</skill_control_v1>",
			].join("\n"),
		);

		expect(result.visibleText).toBe("I captured the decision.");
		expect(result.metadata?.pendingSkillNoteIntents).toEqual([
			{
				operationId: "note-intent-1",
				kind: "note_intent",
				action: "create",
				title: "Decision",
				body: "Use the shorter plan.",
			},
		]);
		expect(result.operations).toEqual(result.metadata?.pendingSkillNoteIntents);
	});

	it("validates replace and append note operations with explicit targets and bodies", () => {
		const result = parseSkillControlEnvelopeFromAssistantText(
			[
				"I updated the note.",
				"<skill_control_v1>",
				JSON.stringify({
					version: 1,
					operations: [
						{
							operationId: "note-replace-1",
							kind: "note_intent",
							action: "replace",
							targetArtifactId: "note-1",
							body: "Replacement body.",
						},
						{
							operationId: "note-append-1",
							kind: "note_intent",
							action: "append",
							targetArtifactId: "note-1",
							body: "Follow-up entry.",
						},
					],
				}),
				"</skill_control_v1>",
			].join("\n"),
		);

		expect(result.metadata?.pendingSkillNoteIntents).toEqual([
			{
				operationId: "note-replace-1",
				kind: "note_intent",
				action: "replace",
				targetArtifactId: "note-1",
				body: "Replacement body.",
			},
			{
				operationId: "note-append-1",
				kind: "note_intent",
				action: "append",
				targetArtifactId: "note-1",
				body: "Follow-up entry.",
			},
		]);
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
				instructions: "Find missing owners, vague deadlines, and risky assumptions.",
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
});
