import { describe, expect, it } from "vitest";
import {
	type ChecklistCampaign,
	type ChecklistSlide,
	checklistIssueKeys,
	checklistRuleLabelKey,
	evaluateCampaignChecklist,
	slideFieldFailures,
	slideHasFailure,
	slideLocaleHasFailure,
	slideMenuAttention,
	summarizeFailures,
} from "./campaign-checklist";

function slide(overrides: Partial<ChecklistSlide> = {}): ChecklistSlide {
	return {
		localId: overrides.localId ?? "slide-1",
		kind: overrides.kind ?? "standard",
		semanticRole: overrides.semanticRole ?? "feature",
		sortOrder: overrides.sortOrder ?? 1,
		titleEn: "Atlas writes the report",
		titleHu: "Az Atlas megírja a jelentést",
		bodyEn: "Ask a question.",
		bodyHu: "Tegyél fel egy kérdést.",
		altEn: "",
		altHu: "",
		actionLabelEn: "",
		actionLabelHu: "",
		actionUrl: "",
		setupControls: [],
		...overrides,
	};
}

function campaign(
	overrides: Partial<ChecklistCampaign> = {},
): ChecklistCampaign {
	return {
		type: "release_update",
		name: "Atlas reports",
		releaseVersion: "2.4.0",
		slides: [slide()],
		...overrides,
	};
}

describe("evaluateCampaignChecklist", () => {
	it("passes a complete release campaign", () => {
		const checklist = evaluateCampaignChecklist(campaign());
		expect(checklist.ready).toBe(true);
		expect(checklist.failedCount).toBe(0);
		expect(checklist.passedCount).toBe(checklist.totalCount);
		expect(checklist.totalCount).toBeGreaterThan(5);
	});

	it("only counts rules that apply to this campaign", () => {
		const release = evaluateCampaignChecklist(campaign());
		const firstRun = evaluateCampaignChecklist(
			campaign({ type: "first_run_onboarding", releaseVersion: "" }),
		);
		const releaseRules = release.rules.map((rule) => rule.id);
		const firstRunRules = firstRun.rules.map((rule) => rule.id);

		expect(releaseRules).toContain("releaseVersion");
		expect(releaseRules).not.toContain("setupSlide");
		expect(releaseRules).not.toContain("dataDisclosure");
		expect(firstRunRules).not.toContain("releaseVersion");
		expect(firstRunRules).toEqual(
			expect.arrayContaining(["setupSlide", "dataDisclosure"]),
		);
	});

	it("keeps every rule the old publish gate enforced", () => {
		const broken = evaluateCampaignChecklist({
			type: "first_run_onboarding",
			name: "  ",
			releaseVersion: "",
			slides: [
				slide({
					localId: "a",
					titleHu: "",
					bodyHu: "",
					desktopAssetId: "crop-1",
					altEn: "",
					altHu: "",
					actionUrl: "https://example.com",
					actionLabelEn: "",
					actionLabelHu: "",
					setupControls: ["ui_language"],
					sortOrder: 1,
				}),
				slide({ localId: "b", sortOrder: 1 }),
			],
		});
		const failing = broken.rules
			.filter((rule) => !rule.passed)
			.map((rule) => rule.id);

		expect(failing).toEqual(
			expect.arrayContaining([
				"name",
				"order",
				"localizedContent",
				"imageAlt",
				"actionDestination",
				"actionLabels",
				"setupControls",
				"setupSlide",
				"dataDisclosure",
			]),
		);
		expect(broken.ready).toBe(false);
	});

	it("requires release version only for release campaigns", () => {
		expect(
			evaluateCampaignChecklist(campaign({ releaseVersion: "" })).ready,
		).toBe(false);
		expect(
			evaluateCampaignChecklist(
				campaign({
					type: "first_run_onboarding",
					releaseVersion: "",
					slides: [
						slide({ localId: "setup", kind: "setup" }),
						slide({
							localId: "data",
							semanticRole: "data_disclosure",
							sortOrder: 2,
						}),
					],
				}),
			).ready,
		).toBe(true);
	});

	it("asks for alt text only once an image is attached", () => {
		expect(evaluateCampaignChecklist(campaign()).ready).toBe(true);
		const withImage = evaluateCampaignChecklist(
			campaign({ slides: [slide({ desktopAssetId: "crop-1" })] }),
		);
		expect(withImage.ready).toBe(false);
		expect(
			withImage.failures.filter((failure) => failure.ruleId === "imageAlt"),
		).toHaveLength(2);
	});

	it("accepts an allow-listed destination that carries a query string, as the server does", () => {
		expect(
			evaluateCampaignChecklist(
				campaign({
					slides: [
						slide({
							actionUrl: "/chat?new=1",
							actionLabelEn: "Open chat",
							actionLabelHu: "Chat megnyitása",
						}),
					],
				}),
			).ready,
		).toBe(true);
		expect(
			evaluateCampaignChecklist(
				campaign({
					slides: [
						slide({
							actionUrl: "internal:chatgpt-import",
							actionLabelEn: "Import",
							actionLabelHu: "Importálás",
						}),
					],
				}),
			).ready,
		).toBe(false);
	});

	it("accepts only allow-listed action destinations", () => {
		expect(
			evaluateCampaignChecklist(
				campaign({
					slides: [
						slide({
							actionUrl: "/chat",
							actionLabelEn: "Open chat",
							actionLabelHu: "Chat megnyitása",
						}),
					],
				}),
			).ready,
		).toBe(true);
		expect(
			evaluateCampaignChecklist(
				campaign({
					slides: [
						slide({
							actionUrl: "/nope",
							actionLabelEn: "Open",
							actionLabelHu: "Megnyitás",
						}),
					],
				}),
			).ready,
		).toBe(false);
	});

	it("produces server-shaped issue paths, de-duplicated", () => {
		const checklist = evaluateCampaignChecklist(
			campaign({
				slides: [
					slide({
						localId: "x",
						id: "slide-x",
						actionUrl: "/chat",
						actionLabelEn: "",
						actionLabelHu: "",
					}),
				],
			}),
		);
		const issues = checklistIssueKeys(checklist);
		const actionLabelIssues = issues.filter(
			(issue) => issue.path === "slides.slide-x.actionLabel",
		);
		expect(actionLabelIssues).toHaveLength(1);
		expect(actionLabelIssues[0].messageKey).toBe(
			"admin.campaigns.validation.actionLabelsRequired",
		);
	});
});

describe("summarizeFailures", () => {
	it("collapses the four localized failures of a slide into one row per language", () => {
		const checklist = evaluateCampaignChecklist(
			campaign({
				slides: [
					slide({ localId: "s1", titleHu: "", bodyHu: "", sortOrder: 1 }),
				],
			}),
		);
		const rows = summarizeFailures(checklist);
		const localized = rows.filter((row) => row.ruleId === "localizedContent");
		expect(localized).toHaveLength(1);
		expect(localized[0].labelKey).toBe(
			"admin.campaigns.checklist.fail.localizedTitleAndBody",
		);
		expect(localized[0].locale).toBe("hu");
		expect(localized[0].slideIndex).toBe(0);
	});

	it("names only the missing half when one field is filled", () => {
		const checklist = evaluateCampaignChecklist(
			campaign({ slides: [slide({ localId: "s1", bodyHu: "" })] }),
		);
		expect(summarizeFailures(checklist)[0].labelKey).toBe(
			"admin.campaigns.checklist.fail.localizedBody",
		);
	});

	it("keeps a stable rule label for the all-pass list", () => {
		expect(checklistRuleLabelKey("dataDisclosure")).toBe(
			"admin.campaigns.checklist.rule.dataDisclosure",
		);
	});
});

describe("slide-level lookups", () => {
	const firstRun = evaluateCampaignChecklist({
		type: "first_run_onboarding",
		name: "First run",
		releaseVersion: "",
		slides: [
			slide({ localId: "a", kind: "setup", sortOrder: 1 }),
			slide({ localId: "b", sortOrder: 2, titleHu: "" }),
		],
	});

	it("marks the slide that owns a failure", () => {
		expect(slideHasFailure(firstRun, "b")).toBe(true);
		expect(slideLocaleHasFailure(firstRun, "b", "hu")).toBe(true);
		expect(slideLocaleHasFailure(firstRun, "b", "en")).toBe(false);
	});

	it("exposes field-level failures for inline errors", () => {
		expect(slideFieldFailures(firstRun, "b").has("title:hu")).toBe(true);
		expect(slideFieldFailures(firstRun, "a").size).toBe(0);
	});

	it("dots the ⋯ menu entry that fixes a campaign-wide rule", () => {
		// No slide is marked as a data disclosure, so Purpose needs attention on
		// every slide — any of them could be the one you change.
		expect(slideMenuAttention(firstRun, "a")).toMatchObject({
			purpose: true,
			layout: false,
			any: true,
		});
		expect(slideMenuAttention(firstRun, "b").purpose).toBe(true);
	});

	it("clears the dot once the rule is satisfied", () => {
		const satisfied = evaluateCampaignChecklist({
			type: "first_run_onboarding",
			name: "First run",
			releaseVersion: "",
			slides: [
				slide({ localId: "a", kind: "setup", sortOrder: 1 }),
				slide({ localId: "b", sortOrder: 2, semanticRole: "data_disclosure" }),
			],
		});
		expect(slideMenuAttention(satisfied, "a").any).toBe(false);
		expect(slideMenuAttention(satisfied, "b").any).toBe(false);
	});

	it("dots Setup controls on the slide that misplaces them", () => {
		const misplaced = evaluateCampaignChecklist(
			campaign({
				slides: [slide({ localId: "s1", setupControls: ["theme"] })],
			}),
		);
		expect(slideMenuAttention(misplaced, "s1")).toMatchObject({
			setupControls: true,
			any: true,
		});
	});
});
