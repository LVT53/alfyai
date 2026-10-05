import { describe, expect, it } from "vitest";
import settingsDict from "$lib/i18n/settings";
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
	});

	it("accepts the allow-listed internal action the campaign modal can handle", () => {
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
		).toBe(true);
	});

	it("rejects internal actions that are not on the allow-list, query string included", () => {
		for (const actionUrl of [
			"internal:chatgpt-import?x=1",
			"internal:anything-else",
			"internal:",
		]) {
			expect(
				evaluateCampaignChecklist(
					campaign({
						slides: [
							slide({
								actionUrl,
								actionLabelEn: "Go",
								actionLabelHu: "Menj",
							}),
						],
					}),
				).ready,
			).toBe(false);
		}
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

describe("artifact_tour slide shape (Slice 6)", () => {
	function tourSlides(
		overrides: Partial<
			Record<"summary" | "1" | "2" | "3", Partial<ChecklistSlide>>
		> = {},
	): ChecklistSlide[] {
		return [
			slide({
				localId: "summary",
				kind: "summary",
				sortOrder: 1,
				...overrides.summary,
			}),
			slide({
				localId: "s1",
				kind: "standard",
				sortOrder: 2,
				...overrides["1"],
			}),
			slide({
				localId: "s2",
				kind: "standard",
				sortOrder: 3,
				...overrides["2"],
			}),
			slide({
				localId: "s3",
				kind: "standard",
				sortOrder: 4,
				...overrides["3"],
			}),
		];
	}

	it("lets the client check a tour with one summary and three standard slides", () => {
		const checklist = evaluateCampaignChecklist(
			campaign({
				type: "artifact_tour",
				releaseVersion: "canvas",
				slides: tourSlides(),
			}),
		);
		expect(checklist.ready).toBe(true);
		expect(
			checklist.rules.find((rule) => rule.id === "tourShape")?.passed,
		).toBe(true);
	});

	it("blocks publishing a tour whose summary slide is missing", () => {
		const slides = tourSlides();
		slides[0] = { ...slides[0], kind: "standard" };
		const checklist = evaluateCampaignChecklist(
			campaign({ type: "artifact_tour", releaseVersion: "canvas", slides }),
		);
		expect(checklist.ready).toBe(false);
		expect(
			checklist.failures.some((failure) => failure.ruleId === "tourShape"),
		).toBe(true);
	});

	it("blocks a tour with the wrong slide count", () => {
		const checklist = evaluateCampaignChecklist(
			campaign({
				type: "artifact_tour",
				releaseVersion: "canvas",
				slides: tourSlides().slice(0, 3),
			}),
		);
		expect(checklist.ready).toBe(false);
		expect(
			checklist.failures.some((failure) => failure.ruleId === "tourShape"),
		).toBe(true);
	});

	it("does not evaluate the tour shape rule for other campaign types", () => {
		const checklist = evaluateCampaignChecklist(
			campaign({ type: "release_update", slides: [slide()] }),
		);
		expect(checklist.rules.some((rule) => rule.id === "tourShape")).toBe(false);
	});

	it("lets the type gate and the layout gate both pass a well-shaped tour", () => {
		// The type gate accepts artifact_tour, and the layout gate accepts a
		// `summary` slide on it (the picker widening in SlideOptionsDialog.svelte
		// mirrors this), so a well-shaped tour is never blocked by the two enum
		// gates before it even reaches the shape rule.
		const checklist = evaluateCampaignChecklist(
			campaign({
				type: "artifact_tour",
				releaseVersion: "canvas",
				slides: tourSlides(),
			}),
		);
		expect(checklist.rules.find((rule) => rule.id === "type")?.passed).toBe(
			true,
		);
		expect(checklist.rules.find((rule) => rule.id === "layout")?.passed).toBe(
			true,
		);
	});

	// Ruling 71: the mirror of the server's `tourKind` rule
	// (announcement-campaigns.ts `validatePublishInput`). A tour is found by its
	// release text, which must be a kind whose tour ships.
	describe("the kind a tour introduces", () => {
		const kindRule = (releaseVersion: string) =>
			evaluateCampaignChecklist(
				campaign({
					type: "artifact_tour",
					releaseVersion,
					slides: tourSlides(),
				}),
			);

		it("lets each kind that ships through, and names the rule among the passing ones", () => {
			for (const kind of ["document", "app", "canvas"]) {
				const checklist = kindRule(kind);
				expect(checklist.ready).toBe(true);
				expect(
					checklist.rules.find((rule) => rule.id === "tourKind")?.passed,
				).toBe(true);
			}
		});

		it("blocks a tour whose release is not a kind that ships", () => {
			for (const release of ["2.1.0", "slides", "file", "Canvas", "", "  "]) {
				const checklist = kindRule(release);
				expect(checklist.ready, `release "${release}"`).toBe(false);
				expect(
					checklist.failures.filter((failure) => failure.ruleId === "tourKind"),
				).toEqual([
					{
						ruleId: "tourKind",
						path: "tourKind",
						messageKey: "admin.campaigns.validation.tourKindInvalid",
					},
				]);
			}
		});

		it("fails only this rule when only the kind is wrong", () => {
			const checklist = kindRule("2.1.0");
			expect(
				checklist.rules.filter((rule) => !rule.passed).map((rule) => rule.id),
			).toEqual(["tourKind"]);
		});

		it("is not asked of any other campaign type", () => {
			for (const type of ["release_update", "first_run_onboarding"]) {
				const checklist = evaluateCampaignChecklist(
					campaign({ type, releaseVersion: "2.1.0", slides: [slide()] }),
				);
				expect(checklist.rules.some((rule) => rule.id === "tourKind")).toBe(
					false,
				);
			}
		});

		it("says what is wrong in both languages, in the list, the sentence and the passing label", () => {
			const failing = summarizeFailures(kindRule("2.1.0"));
			expect(failing.map((row) => row.ruleId)).toEqual(["tourKind"]);
			const keys = [
				failing[0]?.labelKey,
				checklistRuleLabelKey("tourKind"),
				"admin.campaigns.validation.tourKindInvalid",
			] as string[];
			for (const key of keys) {
				for (const language of ["en", "hu"] as const) {
					const dictionary = settingsDict[language] as Record<string, string>;
					expect(dictionary[key], `${language} ${key}`).toBeTruthy();
				}
			}
		});
	});
});
