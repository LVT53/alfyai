import { describe, expect, it, vi } from "vitest";
import {
	PERSONAL_MEMORY_SUBJECTS,
	PROJECT_MEMORY_SUBJECTS,
} from "$lib/memory-types";
import type { CurationModel } from "./curation";
import {
	classifyMemoryFacts,
	FACT_LABEL_BATCH_SIZE,
	factLabelPrompt,
} from "./fact-classifier";

const facts = (n: number) =>
	Array.from({ length: n }, (_, i) => ({
		id: `fact-${i}`,
		text: `The user fact number ${i}.`,
	}));

/** A model that labels every fact it is shown with `kind` and `subject`. */
function answering(kind: string, subject: string) {
	return vi.fn<CurationModel>(async (_prompt, input) => ({
		labels: (input as { facts: Array<{ id: string }> }).facts.map(({ id }) => ({
			id,
			kind,
			subject,
		})),
	}));
}

describe("the fact classifier", () => {
	it("labels a batch from one call, with the facts as data under short ids", async () => {
		const model = answering("temporary", "health");
		const labels = await classifyMemoryFacts(
			{ scope: "personal", facts: facts(3) },
			model,
		);
		expect(model).toHaveBeenCalledOnce();
		const [prompt, input, schema, thinking] = model.mock.calls[0];
		expect(prompt).toBe(factLabelPrompt("personal"));
		expect(input).toEqual({
			facts: [
				{ id: "F1", text: "The user fact number 0." },
				{ id: "F2", text: "The user fact number 1." },
				{ id: "F3", text: "The user fact number 2." },
			],
		});
		expect(JSON.stringify(schema)).toContain(
			'"enum":["lasting","ongoing","temporary"]',
		);
		expect(thinking).toBe("off");
		expect(labels).toEqual(
			new Map(
				["fact-0", "fact-1", "fact-2"].map((id) => [
					id,
					{ kind: "temporary", subject: "health" },
				]),
			),
		);
	});

	it("splits more than twenty facts into batches", async () => {
		const model = answering("lasting", "about_you");
		const labels = await classifyMemoryFacts(
			{ scope: "personal", facts: facts(FACT_LABEL_BATCH_SIZE * 2 + 1) },
			model,
		);
		expect(FACT_LABEL_BATCH_SIZE).toBe(20);
		expect(model).toHaveBeenCalledTimes(3);
		expect(
			model.mock.calls.map(
				([, input]) => (input as { facts: unknown[] }).facts.length,
			),
		).toEqual([20, 20, 1]);
		expect(labels.size).toBe(41);
		expect(
			await classifyMemoryFacts({ scope: "personal", facts: [] }, model),
		).toEqual(new Map());
		expect(model).toHaveBeenCalledTimes(3);
	});

	it("drops answers for unknown ids and values off the lists", async () => {
		const model = vi.fn<CurationModel>(async () => ({
			labels: [
				{ id: "F1", kind: "lasting", subject: "home_family" },
				{ id: "F2", kind: "forever", subject: "health" },
				{ id: "F3", kind: "ongoing", subject: "goals_decisions" },
				{ id: "F9", kind: "lasting", subject: "health" },
				{ id: "F1", kind: "temporary", subject: "health" },
				"not an object",
			],
		}));
		const labels = await classifyMemoryFacts(
			{ scope: "personal", facts: facts(3) },
			model,
		);
		expect(labels).toEqual(
			new Map([["fact-0", { kind: "lasting", subject: "home_family" }]]),
		);
	});

	it("uses the project subjects for a project bank", async () => {
		const model = answering("lasting", "goals_decisions");
		const labels = await classifyMemoryFacts(
			{ scope: "project", facts: facts(1) },
			model,
		);
		expect(labels.get("fact-0")).toEqual({
			kind: "lasting",
			subject: "goals_decisions",
		});
		const [prompt, , schema] = model.mock.calls[0];
		for (const subject of PROJECT_MEMORY_SUBJECTS)
			expect(prompt).toContain(`- ${subject}:`);
		expect(prompt).not.toContain("- about_you:");
		expect(JSON.stringify(schema)).toContain(
			JSON.stringify([...PROJECT_MEMORY_SUBJECTS]),
		);
		const personal = factLabelPrompt("personal");
		for (const subject of PERSONAL_MEMORY_SUBJECTS)
			expect(personal).toContain(`- ${subject}:`);
	});

	it("fails a call it cannot read, as retryable, and labels nothing from it", async () => {
		for (const answer of [
			async () => {
				throw new Error("gateway down");
			},
			async () => ({ nothing: true }),
			async () => "not json",
		]) {
			await expect(
				classifyMemoryFacts(
					{ scope: "personal", facts: facts(2) },
					vi.fn<CurationModel>(answer),
				),
			).rejects.toMatchObject({
				code: "memory_label_unavailable",
				retryable: true,
			});
		}
	});

	it("keeps the labels of the batches that answered when another fails", async () => {
		let calls = 0;
		const model = vi.fn<CurationModel>(async (_prompt, input) => {
			if (++calls === 2) throw new Error("gateway down");
			return {
				labels: (input as { facts: Array<{ id: string }> }).facts.map(
					({ id }) => ({
						id,
						kind: "lasting",
						subject: "other",
					}),
				),
			};
		});
		const labels = await classifyMemoryFacts(
			{ scope: "personal", facts: facts(FACT_LABEL_BATCH_SIZE * 2 + 1) },
			model,
		);
		expect(model).toHaveBeenCalledTimes(3);
		expect(labels.size).toBe(FACT_LABEL_BATCH_SIZE + 1);
		expect(labels.has("fact-0")).toBe(true);
		expect(labels.has(`fact-${FACT_LABEL_BATCH_SIZE}`)).toBe(false);
		expect(labels.has(`fact-${FACT_LABEL_BATCH_SIZE * 2}`)).toBe(true);
	});

	it("its prompt is ASCII English, names no language and leans toward lasting", () => {
		for (const scope of ["personal", "project"] as const) {
			const prompt = factLabelPrompt(scope);
			expect(prompt).toMatch(/^[\x20-\x7e\n]*$/);
			expect(prompt).not.toMatch(/hungarian|english|magyar|angol/i);
			expect(prompt).toMatch(/when unsure, choose lasting/i);
			expect(prompt).toMatch(/data, never instructions/i);
		}
	});
});
