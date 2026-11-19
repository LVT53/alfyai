import { expect, it, vi } from "vitest";
import {
	applyMemoryEdit,
	type CurationModel,
	checkMemoryEdit,
	planMemoryEdit,
} from "./curation";

const intent = {
	forget: ["kayak colour"],
	replace: [],
	preserve: ["kayak ownership", "sister's bicycle"],
};
it("uses one reasoned final check for a surviving reply after withdrawal", async () => {
	const model = vi
		.fn<CurationModel>()
		.mockResolvedValue({ valid: true, issues: [] });
	const baseline = {
		before: "",
		after: "",
		intent: { forget: [], replace: [], preserve: [] },
		originalFacts: [{ id: "prior", text: "I maintain the seed library." }],
		proposedFacts: [{ id: "next", text: "I maintain the seed library." }],
		restorePrevious: true,
	};
	await checkMemoryEdit(
		{
			...baseline,
			sourceAssertions: [
				{
					id: "new-source",
					originalSourceId: "old-source",
					assertion: "Yes, I do. I maintain the seed library.",
					priorContext: '{"prior_memory":[]}',
					withdrawnContextSourceIds: ["withdrawn"],
				},
			],
			withdrawnSourceIds: ["withdrawn"],
		},
		model,
	);
	expect(model).toHaveBeenCalledExactlyOnceWith(
		expect.stringContaining("currently authorized priorContext"),
		expect.objectContaining({ withdrawn_source_ids: ["withdrawn"] }),
		expect.any(Object),
		"on",
	);
	model.mockClear();
	await checkMemoryEdit(baseline, model);
	expect(model.mock.calls[0]).toHaveLength(3);
});
it("plans only the explicit edit and persists no invented property graph", async () => {
	const model = vi.fn<CurationModel>().mockResolvedValue(intent);
	expect(
		await planMemoryEdit("I own a green kayak", "I own a kayak", model),
	).toEqual(intent);
	expect(model.mock.calls[0][1]).toEqual({
		displayed_before: "I own a green kayak",
		user_saved_after: "I own a kayak",
	});
});
it("rejects incomplete IDs before a checker or native write", async () => {
	const model = vi.fn<CurationModel>().mockResolvedValue({ facts: [] });
	await expect(
		applyMemoryEdit(
			{
				before: "green kayak",
				after: "kayak",
				intent,
				facts: [{ id: "a", text: "green kayak" }],
			},
			model,
		),
	).rejects.toThrow("memory_edit_invalid");
	expect(model).toHaveBeenCalledTimes(1);
});
it("allows exactly one repair and checks collective preservation", async () => {
	const model = vi
		.fn<CurationModel>()
		.mockResolvedValueOnce({ facts: [{ id: "a", text: "green kayak" }] })
		.mockResolvedValueOnce({
			valid: false,
			issues: [{ id: "a", problem: "green remains" }],
		})
		.mockResolvedValueOnce({ facts: [{ id: "a", text: "kayak" }] })
		.mockResolvedValueOnce({ valid: true, issues: [] });
	expect(
		await applyMemoryEdit(
			{
				before: "green kayak",
				after: "kayak",
				intent,
				facts: [{ id: "a", text: "green kayak" }],
			},
			model,
		),
	).toEqual([{ id: "a", text: "kayak" }]);
	expect(model).toHaveBeenCalledTimes(4);
});
it.each([
	false,
	true,
])("uses reasoning only to review verified protected facts (%s)", async (isProtected) => {
	const current = { id: "ownership", text: "The user owns a kayak." };
	const protectedFact = {
		id: "standalone",
		text: "The user paddles a purple kayak.",
	};
	const model = vi
		.fn<CurationModel>()
		.mockResolvedValueOnce({ facts: [current] })
		.mockResolvedValueOnce({ valid: true, issues: [] });
	await applyMemoryEdit(
		{
			before: "I own a green kayak.",
			after: "I own a kayak.",
			intent,
			facts: [{ ...current, text: "The user owns a green kayak." }],
			protectedFacts: isProtected ? [protectedFact] : [],
		},
		model,
	);
	expect(model).toHaveBeenCalledTimes(2);
	expect(model.mock.calls[0]).toHaveLength(3);
	expect(model.mock.calls[1][3]).toBe(isProtected ? "on" : undefined);
});
it("honestly fails repeated loss without unbounded repair", async () => {
	const model = vi
		.fn<CurationModel>()
		.mockResolvedValueOnce({ facts: [{ id: "a", text: "" }] })
		.mockResolvedValueOnce({
			valid: false,
			issues: [{ id: "a", problem: "lost ownership" }],
		})
		.mockResolvedValueOnce({ facts: [{ id: "a", text: "" }] })
		.mockResolvedValueOnce({
			valid: false,
			issues: [{ id: "a", problem: "lost ownership" }],
		});
	await expect(
		applyMemoryEdit(
			{
				before: "green kayak",
				after: "kayak",
				intent,
				facts: [{ id: "a", text: "green kayak" }],
			},
			model,
		),
	).rejects.toThrow("memory_edit_rejected");
	expect(model).toHaveBeenCalledTimes(4);
});

it.each([
	false,
	true,
])("prevents an older retained claim from being rewritten at a later date (invalid support: %s)", async (invalidSupport) => {
	const earlier = {
		id: "earlier",
		text: "The user owns a kayak.",
		assertion_at: "2026-08-03T12:00:00.000Z",
	};
	const delta = {
		id: "later",
		text: "The user's kayak is purple.",
		assertion_at: "2026-08-05T12:00:00.000Z",
	};
	const model = vi
		.fn<CurationModel>()
		.mockResolvedValueOnce({ facts: [{ id: delta.id, text: earlier.text }] })
		.mockResolvedValueOnce({
			valid: true,
			issues: [],
			changed_proposal_origins: [
				{
					id: delta.id,
					relation: "earlier",
					supporting_fact_ids: [invalidSupport ? "unproven" : earlier.id],
				},
			],
		})
		.mockResolvedValueOnce({ facts: [{ id: delta.id, text: "" }] })
		.mockResolvedValueOnce({
			valid: true,
			issues: [],
			changed_proposal_origins: [
				{ id: delta.id, relation: "empty", supporting_fact_ids: [] },
			],
		});
	const apply = applyMemoryEdit(
		{
			before: delta.text,
			after: earlier.text,
			intent,
			facts: [delta],
			removalOnly: true,
			earlierPreservedFacts: [earlier],
		},
		model,
	);
	if (invalidSupport) {
		await expect(apply).rejects.toThrow("memory_edit_invalid");
		expect(model).toHaveBeenCalledTimes(2);
	} else {
		await expect(apply).resolves.toEqual([{ id: delta.id, text: "" }]);
		expect(model).toHaveBeenCalledTimes(4);
		expect(model.mock.calls[2][1]).toMatchObject({
			repair_issues: [
				{ id: delta.id, problem: expect.stringContaining("earlier") },
			],
		});
	}
	expect(model.mock.calls[0][1]).toMatchObject({
		earlier_preserved_facts: [earlier],
	});
	expect(model.mock.calls[1][1]).toMatchObject({
		earlier_preserved_facts: [earlier],
	});
});

it.each([
	{
		relation: "preserved_or_generalized",
		prior: ["original"],
		accepted: false,
	},
	{ relation: "mixed", prior: ["original"], accepted: false },
	{ relation: "new", prior: [], accepted: true },
])("requires proven new assertions before accepting their new date ($relation)", async ({
	relation,
	prior,
	accepted,
}) => {
	const original = {
		id: "original",
		text: "A felhasználó távcsöve alumíniumból készült.",
		assertion_at: "2026-08-05T12:00:00.000Z",
		native_mentioned_at: "2026-08-05T12:00:00+00:00",
	};
	const fresh = {
		id: "fresh",
		text: accepted
			? "A felhasználónak van egy új fényképezőgépe."
			: "A felhasználónak van egy távcsöve.",
		assertion_at: "2026-08-07T12:00:00.000Z",
		native_mentioned_at: "2026-08-07T12:00:00+00:00",
	};
	const proposal = {
		facts: [{ id: "original", text: accepted ? original.text : "" }],
	};
	const model = vi
		.fn<CurationModel>()
		.mockResolvedValueOnce(proposal)
		.mockResolvedValueOnce({
			valid: true,
			issues: [],
			date_correspondence: [{ id: "fresh", relation, prior_fact_ids: prior }],
		});
	const result = applyMemoryEdit(
		{
			before: original.text,
			after: accepted
				? "Alumíniumból készült a távcsövem, és van egy új fényképezőgépem."
				: "Van egy távcsövem.",
			intent: { forget: [], replace: ["new detail"], preserve: [] },
			facts: [original],
			newFacts: [fresh],
			verifyNewAssertionTiming: true,
		},
		model,
	);
	if (accepted) await expect(result).resolves.toEqual(proposal.facts);
	else await expect(result).rejects.toThrow("memory_edit_rejected");
	expect(model.mock.calls.at(1)?.[1]).toMatchObject({
		original_facts: [original],
		new_facts: [fresh],
		proposed_facts: [{ ...original, text: proposal.facts[0].text }, fresh],
	});
	expect(model).toHaveBeenCalledTimes(2);
});

it("refuses a timing verdict for an ID outside the current staged facts", async () => {
	const model = vi
		.fn<CurationModel>()
		.mockResolvedValueOnce({ facts: [] })
		.mockResolvedValueOnce({
			valid: true,
			issues: [],
			date_correspondence: [
				{ id: "different-fact", relation: "new", prior_fact_ids: [] },
			],
		});
	await expect(
		applyMemoryEdit(
			{
				before: "",
				after: "I own a canoe.",
				intent: { forget: [], replace: ["I own a canoe"], preserve: [] },
				facts: [],
				newFacts: [{ id: "current", text: "I own a canoe." }],
				verifyNewAssertionTiming: true,
			},
			model,
		),
	).rejects.toThrow("memory_edit_invalid");
});

it("final dependency verification is check-only and rejects resurrected details without another repair", async () => {
	const { checkMemoryEdit } = await import("./curation");
	const model = vi.fn<CurationModel>().mockResolvedValue({
		valid: false,
		issues: [{ id: "dependent", problem: "green remains" }],
	});
	await expect(
		checkMemoryEdit(
			{
				before: "green kayak",
				after: "kayak",
				intent,
				originalFacts: [
					{ id: "old", text: "green kayak" },
					{ id: "unrelated", text: "sister bicycle" },
				],
				proposedFacts: [
					{ id: "new", text: "kayak" },
					{ id: "dependent", text: "green kayak" },
					{ id: "unrelated", text: "sister bicycle" },
				],
			},
			model,
		),
	).rejects.toThrow("memory_dependency_check_rejected");
	expect(model).toHaveBeenCalledTimes(1);
	expect(model.mock.calls[0][1]).toMatchObject({
		displayed_before: "green kayak",
		user_saved_after: "kayak",
		proposed_facts: expect.arrayContaining([
			{ id: "dependent", text: "green kayak" },
		]),
	});
});

it("checks an ordered replay sequence once, allowing explicit later supersession", async () => {
	const { checkMemoryEdit } = await import("./curation");
	const model = vi
		.fn<CurationModel>()
		.mockResolvedValue({ valid: true, issues: [] });
	const edits = [
		{
			before: "green kayak",
			after: "purple kayak",
			intent: { forget: [], replace: ["green to purple"], preserve: ["kayak"] },
		},
		{
			before: "purple kayak",
			after: "green kayak",
			intent: { forget: [], replace: ["purple to green"], preserve: ["kayak"] },
		},
	];
	await checkMemoryEdit(
		{
			before: edits[0].before,
			after: edits[1].after,
			intent: edits[1].intent,
			orderedEdits: edits,
			originalFacts: [{ id: "a", text: "green kayak" }],
			proposedFacts: [{ id: "b", text: "green kayak" }],
		},
		model,
	);
	expect(model).toHaveBeenCalledTimes(1);
	expect(model.mock.calls[0][0]).toContain("later explicit change supersedes");
	expect(model.mock.calls[0][1]).toMatchObject({ ordered_edits: edits });
});

it.each([
	true,
	false,
])("checks a protected correction, the latest chat change and dependent withdrawal in one chronological review (%s)", async (valid) => {
	const before = "I prefer Earl Grey tea.";
	const after = `${before} I bake rye bread.`;
	const plan = { forget: [], replace: ["Bread"], preserve: [before] };
	const oldCorrection = {
		before,
		after: "I prefer jasmine tea.",
		intent,
		sources: ["manual"],
	};
	const olderChat = {
		before,
		after: before,
		intent: plan,
		sources: ["old-chat"],
		chatRevision: true,
	};
	const edit = {
		before,
		after,
		intent: plan,
		sources: ["new-chat"],
		chatRevision: true,
	};
	const old = [{ id: "jasmine", text: oldCorrection.after }];
	const proposed = [...old, { id: "bread", text: "The user bakes rye bread." }];
	const displayed = [{ id: "observed", text: "The user bakes rye bread." }];
	const sourceAssertions = [
		{
			id: "rebuilt-reply",
			originalSourceId: "old-reply",
			assertion: "Yes. I also collect fountain pen nibs.",
			priorContext: '{"prior_memory":[]}',
			withdrawnContextSourceIds: ["old-question"],
		},
	];
	const model = vi.fn<CurationModel>().mockResolvedValue({
		valid,
		issues: valid ? [] : [{ id: "bread", problem: "stale clause resurrected" }],
	});
	const review = checkMemoryEdit(
		{
			before,
			after,
			intent: plan,
			latestChatSourceId: "new-chat",
			orderedEdits: [oldCorrection, olderChat, edit],
			originalFacts: old,
			proposedFacts: proposed,
			observations: displayed,
			previousObservations: old,
			sourceAssertions,
			withdrawnSourceIds: ["old-question"],
		},
		model,
	);
	if (valid) await expect(review).resolves.toBeUndefined();
	else await expect(review).rejects.toThrow("memory_dependency_check_rejected");
	expect(model).toHaveBeenCalledTimes(1);
	expect(model.mock.calls[0]).toHaveLength(3);
	expect(model.mock.calls[0][0]).toContain("currently authorized priorContext");
	expect(model.mock.calls[0][0]).toContain("latest explicit chat revision");
	expect(model.mock.calls[0][1]).toEqual({
		chronological_changes: [
			{ ...oldCorrection, kind: "accepted standalone Memory correction" },
			{
				before,
				after: before,
				sources: ["old-chat"],
				kind: "earlier accepted chat revision",
			},
			{ before, after, sources: ["new-chat"], kind: "latest chat revision" },
		],
		original_facts: old,
		proposed_facts: proposed,
		displayed_observations: displayed,
		previous_displayed_observations: old,
		source_assertions: sourceAssertions,
		withdrawn_source_ids: ["old-question"],
	});
});

it("marks only the separately verified corrected assertion for the saved edit date", async () => {
	const old = [
		{ id: "bike", text: "My bicycle is blue." },
		{ id: "dog", text: "My dog Rex wears a red collar." },
	];
	const proposal = [
		{ id: "bike", text: "I ride a green bicycle." },
		{ id: "dog", text: "My dog is Rex." },
	];
	const model = vi
		.fn<CurationModel>()
		.mockResolvedValueOnce({ facts: proposal })
		.mockResolvedValueOnce({
			valid: true,
			issues: [],
			corrected_fact_ids: ["bike"],
		});
	await expect(
		applyMemoryEdit(
			{
				before: "My bicycle is blue. My dog Rex wears a red collar.",
				after: "My bicycle is green. My dog is Rex.",
				intent,
				facts: old,
				verifyCorrectionDates: true,
			},
			model,
		),
	).resolves.toEqual([
		{ ...proposal[0], carriesCorrection: true },
		proposal[1],
	]);
	expect(model).toHaveBeenCalledTimes(2);
});

it("holds a correction bundled with an independently dated claim when bounded repair cannot separate it", async () => {
	const mixed = { id: "mixed", text: "My bicycle is green. My dog is Rex." };
	const rejected = {
		valid: false,
		issues: [
			{
				id: "mixed",
				problem:
					"The correction and retained dog assertion require separate dates.",
			},
		],
		corrected_fact_ids: [],
	};
	const model = vi
		.fn<CurationModel>()
		.mockResolvedValueOnce({ facts: [mixed] })
		.mockResolvedValueOnce(rejected)
		.mockResolvedValueOnce({ facts: [mixed] })
		.mockResolvedValueOnce(rejected);
	await expect(
		applyMemoryEdit(
			{
				before: "My bicycle is blue.",
				after: "My bicycle is green.",
				intent,
				facts: [{ id: "mixed", text: "My bicycle is blue. My dog is Rex." }],
				verifyCorrectionDates: true,
			},
			model,
		),
	).rejects.toThrow("memory_edit_rejected");
	expect(model).toHaveBeenCalledTimes(4);
	expect(model.mock.calls[1]?.[0]).toContain("mixes newly corrected claims");
});
