import { describe, expect, it } from "vitest";
import { parseSkillControlEnvelopeFromAssistantText } from "./skill-control-envelope";

describe("skill control envelopes", () => {
	// A reply cut off inside its envelope (the output limit lands there, since
	// the envelope comes last) shows none of the half-written block, guesses no
	// operation from it and counts it as malformed. The stream runtime reads
	// the end of a reply the same way.
	it("drops an envelope the reply was cut off inside, guessing no operations", () => {
		const result = parseSkillControlEnvelopeFromAssistantText(
			[
				"Visible answer",
				"<skill_control_v1>",
				'{"version":1,"operations":[{"operationId":"partial"',
			].join("\n"),
		);

		expect(result.visibleText).toBe("Visible answer");
		expect(result.operations).toEqual([]);
		expect(result.metadata?.skillControl?.malformedEnvelopeCount).toBe(1);
	});

	it("keeps an open tag that prose, not JSON, follows visible", () => {
		const result = parseSkillControlEnvelopeFromAssistantText(
			"The block starts with <skill_control_v1> and then the JSON.",
		);

		expect(result.visibleText).toBe(
			"The block starts with <skill_control_v1> and then the JSON.",
		);
		expect(result.metadata).toBeUndefined();
	});

	// The real model left the close tag off 1 of 32 drafts (2026-10-25): the
	// open tag and one whole JSON object are the envelope it meant to write.
	it("reads a whole envelope whose close tag the model left off", () => {
		const envelope = {
			version: 1,
			operations: [
				{
					operationId: "skill-draft-1",
					kind: "skill_draft",
					draft: {
						id: "weekly-status",
						displayName: "Weekly status",
						instructions: "Write what is done, next and blocked.",
					},
				},
			],
		};
		const result = parseSkillControlEnvelopeFromAssistantText(
			`Here is the draft.\n\n<skill_control_v1>\n${JSON.stringify(envelope)}`,
		);

		expect(result.visibleText).toBe("Here is the draft.");
		expect(result.metadata?.skillDrafts?.map((draft) => draft.id)).toEqual([
			"weekly-status",
		]);
	});

	it("keeps the words after an unclosed envelope's JSON visible", () => {
		const result = parseSkillControlEnvelopeFromAssistantText(
			'Draft:\n<skill_control_v1>\n{"version":1,"operations":[{"operationId":"skill-draft-1","kind":"skill_draft","draft":{"id":"digest","displayName":"Digest","instructions":"Summarize the notes."}}]}\n\nTell me what to change.',
		);

		expect(result.visibleText).toBe("Draft:\n\n\nTell me what to change.");
		expect(result.metadata?.skillDrafts?.map((draft) => draft.id)).toEqual([
			"digest",
		]);
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
