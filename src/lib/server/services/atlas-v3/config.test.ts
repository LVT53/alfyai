import { describe, expect, it } from "vitest";
import {
	ATLAS_V3_MODEL_TASKS,
	atlasV3BudgetForNode,
	atlasV3RunawayRetryMaxOutputTokens,
	atlasV3SectionBudget,
	atlasV3SectionMaxOutputTokens,
	getAtlasV3ProfileConfig,
	resolveAtlasV3TaskModel,
} from "./config";

describe("resolveAtlasV3TaskModel", () => {
	const base = {
		synthesisModel: "model1" as const,
		auditModel: "model2" as const,
	};

	it("inherits the synthesis model for the writer-shaped tasks", () => {
		for (const task of ["researcher", "writer"] as const) {
			const selection = resolveAtlasV3TaskModel({
				task,
				...base,
				taskModels: {},
			});
			expect(selection.model).toBe("model1");
			expect(selection.explicit).toBe(false);
		}
	});

	it("inherits the audit model for the control-shaped tasks", () => {
		for (const task of ["ask", "outline", "critic", "verifier"] as const) {
			const selection = resolveAtlasV3TaskModel({
				task,
				...base,
				taskModels: {},
			});
			expect(selection.model).toBe("model2");
			expect(selection.explicit).toBe(false);
		}
	});

	it("prefers the task's own key when it is set", () => {
		const selection = resolveAtlasV3TaskModel({
			task: "critic",
			...base,
			taskModels: { critic: "provider:openrouter:some-model" },
		});
		expect(selection.model).toBe("provider:openrouter:some-model");
		expect(selection.explicit).toBe(true);
	});

	it("covers every task in the list", () => {
		for (const task of ATLAS_V3_MODEL_TASKS) {
			expect(
				resolveAtlasV3TaskModel({ task, ...base, taskModels: {} }).model,
			).toBeTruthy();
		}
	});
});

describe("getAtlasV3ProfileConfig", () => {
	it("gives the exhaustive profile three merged research passes", () => {
		expect(getAtlasV3ProfileConfig("exhaustive").researchPasses).toBe(3);
		expect(getAtlasV3ProfileConfig("overview").researchPasses).toBe(1);
	});

	it("clamps the searches per step into the 3-5 band", () => {
		expect(
			getAtlasV3ProfileConfig("overview", { searchesPerStep: 99 })
				.searchesPerStep,
		).toBe(5);
		expect(
			getAtlasV3ProfileConfig("overview", { searchesPerStep: 1 })
				.searchesPerStep,
		).toBe(3);
	});

	it("never lets maxSections fall below minSections", () => {
		const config = getAtlasV3ProfileConfig("overview", {
			minSections: 5,
			maxSections: 2,
		});
		expect(config.maxSections).toBeGreaterThanOrEqual(config.minSections);
	});
});

describe("atlasV3SectionBudget", () => {
	it("divides the band's midpoint across the sections actually planned", () => {
		const config = getAtlasV3ProfileConfig("overview");
		const three = atlasV3SectionBudget({ config, sectionCount: 3 });
		const six = atlasV3SectionBudget({ config, sectionCount: 6 });
		expect(three.targetWords).toBeGreaterThan(six.targetWords);
		expect(three.minSentences).toBeLessThanOrEqual(three.maxSentences);
	});

	it("never asks for more words than its sentence cap can hold", () => {
		const config = getAtlasV3ProfileConfig("exhaustive");
		const budget = atlasV3SectionBudget({ config, sectionCount: 1 });
		expect(budget.targetWords).toBeLessThanOrEqual(budget.maxSentences * 20);
	});

	it("holds the sentence floor to the evidence the node actually has", () => {
		const config = getAtlasV3ProfileConfig("in-depth");
		const budget = atlasV3SectionBudget({ config, sectionCount: 3 });
		expect(budget.minSentences).toBeGreaterThan(3);
		// Two quotes buy three sentences, never the word share's target.
		expect(atlasV3BudgetForNode(budget, 2).minSentences).toBe(3);
		expect(atlasV3BudgetForNode(budget, 0).minSentences).toBe(2);
		// A node with plenty of evidence keeps the budget's own floor.
		expect(atlasV3BudgetForNode(budget, 40).minSentences).toBe(
			budget.minSentences,
		);
		expect(atlasV3BudgetForNode(budget, 2).maxSentences).toBe(
			budget.maxSentences,
		);
	});

	it("applies the floor from the builder too", () => {
		const config = getAtlasV3ProfileConfig("in-depth");
		expect(
			atlasV3SectionBudget({ config, sectionCount: 3, evidenceCount: 1 })
				.minSentences,
		).toBe(2);
	});
});

describe("output caps", () => {
	it("sizes the writer cap to the section and steps down on a retry", () => {
		const cap = atlasV3SectionMaxOutputTokens(600);
		expect(cap).toBe(2400);
		expect(atlasV3RunawayRetryMaxOutputTokens(cap)).toBeLessThan(cap);
	});

	it("keeps a floor under both", () => {
		expect(atlasV3SectionMaxOutputTokens(1)).toBe(1500);
		expect(atlasV3RunawayRetryMaxOutputTokens(1500)).toBe(1500);
	});
});
