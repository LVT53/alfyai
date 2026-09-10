/**
 * Publish-readiness checklist for the admin Campaigns screen.
 *
 * This is the client mirror of the server's publish validation (see
 * `src/lib/server/services/announcement-campaigns.ts`). The redesign collapses
 * the eleven-row checklist into a single status line that only opens when
 * something fails, so the rules need more structure than the old flat
 * `CampaignValidationIssue[]`: every failure now knows which slide it belongs
 * to, which field to point at, which language is missing, and whether it is
 * fixed from the slide's ⋯ menu (Layout / Purpose / Setup controls).
 *
 * Rule coverage is unchanged from the previous screen — the same conditions
 * block publishing, in the same order — only the reporting is richer.
 */

export type ChecklistCampaignType =
	| "first_run_onboarding"
	| "release_update"
	| (string & {});

export type ChecklistSlideKind = "setup" | "standard" | (string & {});

export type ChecklistLocale = "en" | "hu";

export type ChecklistSlide = {
	localId: string;
	id?: string;
	kind: ChecklistSlideKind;
	semanticRole?: string | null;
	sortOrder?: number;
	titleEn?: string | null;
	titleHu?: string | null;
	bodyEn?: string | null;
	bodyHu?: string | null;
	altEn?: string | null;
	altHu?: string | null;
	actionLabelEn?: string | null;
	actionLabelHu?: string | null;
	actionUrl?: string | null;
	desktopAssetId?: string | null;
	mobileAssetId?: string | null;
	setupControls?: string[];
};

export type ChecklistCampaign = {
	type: ChecklistCampaignType;
	name: string;
	releaseVersion: string;
	slides: ChecklistSlide[];
};

export type ChecklistRuleId =
	| "name"
	| "type"
	| "releaseVersion"
	| "slides"
	| "layout"
	| "purpose"
	| "order"
	| "localizedContent"
	| "imageAlt"
	| "actionDestination"
	| "actionLabels"
	| "setupControls"
	| "setupSlide"
	| "dataDisclosure";

/** The three slide properties that live behind the slide's ⋯ menu. */
export type SlideMenuItem = "layout" | "purpose" | "setupControls";

export type ChecklistField =
	| "title"
	| "body"
	| "alt"
	| "actionLabel"
	| "actionDestination"
	| "order"
	| "menu";

export type ChecklistFailure = {
	ruleId: ChecklistRuleId;
	/** Server-compatible issue path, kept so publish-time field errors line up. */
	path: string;
	/** i18n key for the full sentence shown as the validation message. */
	messageKey: string;
	slideIndex?: number;
	slideLocalId?: string;
	field?: ChecklistField;
	locale?: ChecklistLocale;
	/** Set when the failing property is only settable from the slide ⋯ menu. */
	menuItem?: SlideMenuItem;
};

export type ChecklistRule = {
	id: ChecklistRuleId;
	passed: boolean;
	failures: ChecklistFailure[];
};

export type CampaignChecklist = {
	rules: ChecklistRule[];
	failures: ChecklistFailure[];
	passedCount: number;
	totalCount: number;
	failedCount: number;
	ready: boolean;
};

export const ALLOWED_ACTION_DESTINATIONS = [
	"/",
	"/chat",
	"/knowledge",
	"/settings",
	"/settings/profile",
	"/settings/admin",
] as const;

export const ALLOWED_SETUP_CONTROLS = [
	"ui_language",
	"theme",
	"model_default",
	"ai_style",
] as const;

const allowedDestinations = new Set<string>(ALLOWED_ACTION_DESTINATIONS);
const allowedSetupControls = new Set<string>(ALLOWED_SETUP_CONTROLS);

const VALIDATION = "admin.campaigns.validation";

function slidePath(slide: ChecklistSlide, index: number): string {
	return `slides.${slide.id ?? slide.localId ?? index + 1}`;
}

function isBlank(value: string | null | undefined): boolean {
	return !value || !value.trim();
}

/**
 * Evaluates every publish rule that applies to this campaign. Rules that
 * cannot apply (release version on a first-run campaign, the two first-run-only
 * rules on a release campaign) are left out of the total instead of counted as
 * free passes, so "{n} of {m} checks pass" describes real work.
 */
export function evaluateCampaignChecklist(
	campaign: ChecklistCampaign,
): CampaignChecklist {
	const rules = new Map<ChecklistRuleId, ChecklistFailure[]>();
	const applicable: ChecklistRuleId[] = [];

	function use(id: ChecklistRuleId) {
		if (!rules.has(id)) {
			rules.set(id, []);
			applicable.push(id);
		}
	}

	function fail(failure: ChecklistFailure) {
		use(failure.ruleId);
		rules.get(failure.ruleId)?.push(failure);
	}

	const isFirstRun = campaign.type === "first_run_onboarding";

	use("name");
	if (isBlank(campaign.name)) {
		fail({
			ruleId: "name",
			path: "name",
			messageKey: `${VALIDATION}.nameRequired`,
		});
	}

	use("type");
	if (
		campaign.type !== "first_run_onboarding" &&
		campaign.type !== "release_update"
	) {
		fail({
			ruleId: "type",
			path: "type",
			messageKey: `${VALIDATION}.typeInvalid`,
		});
	}

	if (campaign.type === "release_update") {
		use("releaseVersion");
		if (isBlank(campaign.releaseVersion)) {
			fail({
				ruleId: "releaseVersion",
				path: "releaseVersion",
				messageKey: `${VALIDATION}.releaseVersionRequired`,
			});
		}
	}

	use("slides");
	if (campaign.slides.length === 0) {
		fail({
			ruleId: "slides",
			path: "slides",
			messageKey: `${VALIDATION}.slideRequired`,
		});
	}

	if (campaign.slides.length > 0) {
		use("layout");
		use("purpose");
		use("order");
		use("localizedContent");
		use("actionDestination");
		use("actionLabels");
		use("setupControls");
	}

	const seenSortOrders = new Set<number>();
	let setupCount = 0;
	let dataDisclosureCount = 0;

	for (const [index, slide] of campaign.slides.entries()) {
		const prefix = slidePath(slide, index);
		const base = { slideIndex: index, slideLocalId: slide.localId };

		if (slide.kind !== "setup" && slide.kind !== "standard") {
			fail({
				...base,
				ruleId: "layout",
				path: `${prefix}.layoutType`,
				messageKey: `${VALIDATION}.slideLayoutInvalid`,
				field: "menu",
				menuItem: "layout",
			});
		}

		if (
			slide.semanticRole !== "feature" &&
			slide.semanticRole !== "data_disclosure"
		) {
			fail({
				...base,
				ruleId: "purpose",
				path: `${prefix}.semanticRole`,
				messageKey: `${VALIDATION}.semanticRoleInvalid`,
				field: "menu",
				menuItem: "purpose",
			});
		}

		const sortOrder = Number(slide.sortOrder ?? index + 1);
		if (
			!Number.isInteger(sortOrder) ||
			sortOrder <= 0 ||
			seenSortOrders.has(sortOrder)
		) {
			fail({
				...base,
				ruleId: "order",
				path: `${prefix}.sortOrder`,
				messageKey: `${VALIDATION}.sortOrderInvalid`,
				field: "order",
			});
		}
		seenSortOrders.add(sortOrder);

		const localizedFields: Array<{
			field: "title" | "body";
			locale: ChecklistLocale;
			value: string | null | undefined;
		}> = [
			{ field: "title", locale: "en", value: slide.titleEn },
			{ field: "title", locale: "hu", value: slide.titleHu },
			{ field: "body", locale: "en", value: slide.bodyEn },
			{ field: "body", locale: "hu", value: slide.bodyHu },
		];
		for (const entry of localizedFields) {
			if (isBlank(entry.value)) {
				fail({
					...base,
					ruleId: "localizedContent",
					path: `${prefix}.${entry.field}.${entry.locale}`,
					messageKey: `${VALIDATION}.localizedContentRequired`,
					field: entry.field,
					locale: entry.locale,
				});
			}
		}

		const hasUploadedImage = Boolean(
			slide.desktopAssetId || slide.mobileAssetId,
		);
		if (hasUploadedImage) {
			use("imageAlt");
			for (const entry of [
				{ locale: "en" as const, value: slide.altEn },
				{ locale: "hu" as const, value: slide.altHu },
			]) {
				if (isBlank(entry.value)) {
					fail({
						...base,
						ruleId: "imageAlt",
						path: `${prefix}.altText.${entry.locale}`,
						messageKey: `${VALIDATION}.imageAltRequired`,
						field: "alt",
						locale: entry.locale,
					});
				}
			}
		}

		if (slide.actionUrl && !allowedDestinations.has(slide.actionUrl)) {
			fail({
				...base,
				ruleId: "actionDestination",
				path: `${prefix}.actionDestination`,
				messageKey: `${VALIDATION}.actionDestinationInvalid`,
				field: "actionDestination",
			});
		}

		if (slide.actionUrl) {
			for (const entry of [
				{ locale: "en" as const, value: slide.actionLabelEn },
				{ locale: "hu" as const, value: slide.actionLabelHu },
			]) {
				if (isBlank(entry.value)) {
					fail({
						...base,
						ruleId: "actionLabels",
						path: `${prefix}.actionLabel`,
						messageKey: `${VALIDATION}.actionLabelsRequired`,
						field: "actionLabel",
						locale: entry.locale,
					});
				}
			}
		}

		const setupControls = slide.setupControls ?? [];
		if (slide.kind === "setup") setupCount += 1;
		if (slide.kind === "standard" && slide.semanticRole === "data_disclosure") {
			dataDisclosureCount += 1;
		}
		if (
			setupControls.length > 0 &&
			(campaign.type !== "first_run_onboarding" || slide.kind !== "setup")
		) {
			fail({
				...base,
				ruleId: "setupControls",
				path: `${prefix}.setupControls`,
				messageKey: `${VALIDATION}.setupControlsPlacementInvalid`,
				field: "menu",
				menuItem: "setupControls",
			});
		}
		if (setupControls.some((control) => !allowedSetupControls.has(control))) {
			fail({
				...base,
				ruleId: "setupControls",
				path: `${prefix}.setupControls`,
				messageKey: `${VALIDATION}.setupControlsUnsupported`,
				field: "menu",
				menuItem: "setupControls",
			});
		}
	}

	if (isFirstRun) {
		use("setupSlide");
		use("dataDisclosure");
		if (setupCount !== 1) {
			fail({
				ruleId: "setupSlide",
				path: "setupSlide",
				messageKey: `${VALIDATION}.setupSlideRequired`,
				field: "menu",
				menuItem: "layout",
			});
		}
		if (dataDisclosureCount < 1) {
			fail({
				ruleId: "dataDisclosure",
				path: "dataDisclosure",
				messageKey: `${VALIDATION}.dataDisclosureRequired`,
				field: "menu",
				menuItem: "purpose",
			});
		}
	}

	const ruleList: ChecklistRule[] = applicable.map((id) => ({
		id,
		passed: (rules.get(id) ?? []).length === 0,
		failures: rules.get(id) ?? [],
	}));
	const failures = ruleList.flatMap((rule) => rule.failures);
	const failedCount = ruleList.filter((rule) => !rule.passed).length;

	return {
		rules: ruleList,
		failures,
		passedCount: ruleList.length - failedCount,
		totalCount: ruleList.length,
		failedCount,
		ready: failedCount === 0,
	};
}

/**
 * Flat `{ path, message }` issues, the shape the campaigns API and the old
 * checklist both speak. Message keys still need translating by the caller.
 */
export function checklistIssueKeys(
	checklist: CampaignChecklist,
): Array<{ path: string; messageKey: string }> {
	const seen = new Set<string>();
	const issues: Array<{ path: string; messageKey: string }> = [];
	for (const failure of checklist.failures) {
		const key = `${failure.path}::${failure.messageKey}`;
		if (seen.has(key)) continue;
		seen.add(key);
		issues.push({ path: failure.path, messageKey: failure.messageKey });
	}
	return issues;
}

export type ChecklistFailureRow = {
	id: string;
	ruleId: ChecklistRuleId;
	labelKey: string;
	locale?: ChecklistLocale;
	slideIndex?: number;
	slideLocalId?: string;
	menuItem?: SlideMenuItem;
};

/** Neutral rule names, listed when every check passes. */
const RULE_LABEL: Record<ChecklistRuleId, string> = {
	name: "admin.campaigns.checklist.rule.name",
	type: "admin.campaigns.checklist.rule.type",
	releaseVersion: "admin.campaigns.checklist.rule.releaseVersion",
	slides: "admin.campaigns.checklist.rule.slides",
	layout: "admin.campaigns.checklist.rule.layout",
	purpose: "admin.campaigns.checklist.rule.purpose",
	order: "admin.campaigns.checklist.rule.order",
	localizedContent: "admin.campaigns.checklist.rule.localized",
	imageAlt: "admin.campaigns.checklist.rule.alt",
	actionDestination: "admin.campaigns.checklist.rule.actionDestination",
	actionLabels: "admin.campaigns.checklist.rule.actionLabel",
	setupControls: "admin.campaigns.checklist.rule.setupControls",
	setupSlide: "admin.campaigns.checklist.rule.setupSlide",
	dataDisclosure: "admin.campaigns.checklist.rule.dataDisclosure",
};

/** What a failing row says; the localized ones name the missing language. */
const FAILURE_LABEL: Record<ChecklistRuleId, string> = {
	name: "admin.campaigns.checklist.fail.name",
	type: "admin.campaigns.checklist.fail.type",
	releaseVersion: "admin.campaigns.checklist.fail.releaseVersion",
	slides: "admin.campaigns.checklist.fail.slides",
	layout: "admin.campaigns.checklist.fail.layout",
	purpose: "admin.campaigns.checklist.fail.purpose",
	order: "admin.campaigns.checklist.fail.order",
	localizedContent: "admin.campaigns.checklist.fail.localizedTitleAndBody",
	imageAlt: "admin.campaigns.checklist.fail.alt",
	actionDestination: "admin.campaigns.checklist.fail.actionDestination",
	actionLabels: "admin.campaigns.checklist.fail.actionLabel",
	setupControls: "admin.campaigns.checklist.fail.setupControls",
	setupSlide: "admin.campaigns.checklist.fail.setupSlide",
	dataDisclosure: "admin.campaigns.checklist.fail.dataDisclosure",
};

/** The rule label shown in the expanded checklist, per rule id. */
export function checklistRuleLabelKey(ruleId: ChecklistRuleId): string {
	return RULE_LABEL[ruleId];
}

/**
 * Collapses raw failures into the one-line-per-problem list the status line
 * shows: the four localized-content failures of one slide become at most two
 * rows ("English title and body", "Magyar title and body").
 */
export function summarizeFailures(
	checklist: CampaignChecklist,
): ChecklistFailureRow[] {
	type Bucket = {
		row: ChecklistFailureRow;
		fields: Set<ChecklistField>;
	};
	const buckets = new Map<string, Bucket>();
	const order: string[] = [];

	for (const failure of checklist.failures) {
		const key = [
			failure.ruleId,
			failure.slideLocalId ?? "-",
			failure.locale ?? "-",
		].join("::");
		const existing = buckets.get(key);
		if (existing) {
			if (failure.field) existing.fields.add(failure.field);
			continue;
		}
		const bucket: Bucket = {
			row: {
				id: key,
				ruleId: failure.ruleId,
				labelKey: FAILURE_LABEL[failure.ruleId],
				locale: failure.locale,
				slideIndex: failure.slideIndex,
				slideLocalId: failure.slideLocalId,
				menuItem: failure.menuItem,
			},
			fields: new Set(failure.field ? [failure.field] : []),
		};
		buckets.set(key, bucket);
		order.push(key);
	}

	return order.map((key) => {
		const bucket = buckets.get(key);
		if (!bucket) throw new Error(`Missing checklist bucket ${key}`);
		const { row, fields } = bucket;
		if (row.ruleId === "localizedContent") {
			const hasTitle = fields.has("title");
			const hasBody = fields.has("body");
			row.labelKey =
				hasTitle && hasBody
					? "admin.campaigns.checklist.fail.localizedTitleAndBody"
					: hasTitle
						? "admin.campaigns.checklist.fail.localizedTitle"
						: "admin.campaigns.checklist.fail.localizedBody";
		}
		return row;
	});
}

export type SlideMenuAttention = {
	layout: boolean;
	purpose: boolean;
	setupControls: boolean;
	any: boolean;
};

const NO_ATTENTION: SlideMenuAttention = {
	layout: false,
	purpose: false,
	setupControls: false,
	any: false,
};

/**
 * Which ⋯ menu entries of a given slide still need attention.
 *
 * Campaign-level rules that are only fixable through the menu (a first-run
 * campaign needs exactly one setup slide and at least one data-disclosure
 * slide) mark *every* slide's menu, because any slide could be the one you
 * change. Owner decision: the menu item keeps its dot until satisfied.
 */
export function slideMenuAttention(
	checklist: CampaignChecklist,
	slideLocalId: string,
): SlideMenuAttention {
	if (!slideLocalId) return NO_ATTENTION;
	const attention = { ...NO_ATTENTION };
	for (const failure of checklist.failures) {
		if (!failure.menuItem) continue;
		const campaignWide = failure.slideLocalId === undefined;
		if (!campaignWide && failure.slideLocalId !== slideLocalId) continue;
		attention[failure.menuItem] = true;
	}
	attention.any =
		attention.layout || attention.purpose || attention.setupControls;
	return attention;
}

/** True when any failure at all belongs to this slide. */
export function slideHasFailure(
	checklist: CampaignChecklist,
	slideLocalId: string,
): boolean {
	return checklist.failures.some(
		(failure) => failure.slideLocalId === slideLocalId,
	);
}

/** True when a slide has a failure in one language (drives the EN/HU pill dot). */
export function slideLocaleHasFailure(
	checklist: CampaignChecklist,
	slideLocalId: string,
	locale: ChecklistLocale,
): boolean {
	return checklist.failures.some(
		(failure) =>
			failure.slideLocalId === slideLocalId && failure.locale === locale,
	);
}

/**
 * Field-level lookup for the inline errors inside the open slide editor:
 * `has("actionLabel", "hu")`.
 */
export function slideFieldFailures(
	checklist: CampaignChecklist,
	slideLocalId: string,
): Set<string> {
	const keys = new Set<string>();
	for (const failure of checklist.failures) {
		if (failure.slideLocalId !== slideLocalId || !failure.field) continue;
		keys.add(
			failure.locale ? `${failure.field}:${failure.locale}` : failure.field,
		);
	}
	return keys;
}
