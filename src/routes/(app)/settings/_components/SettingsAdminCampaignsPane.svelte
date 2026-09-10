<script lang="ts">
import { invalidateAll } from "$app/navigation";
import { onMount } from "svelte";
import {
	Archive,
	ArrowDown,
	ArrowUp,
	Copy,
	FlaskConical,
	Flag,
	Layers,
	Lock,
	Monitor,
	Pencil,
	SlidersHorizontal,
	Smartphone,
	Trash2,
	TriangleAlert,
} from "@lucide/svelte";
import { fade, slide as slideTransitionFn } from "svelte/transition";
import CampaignCropModal from "$lib/components/campaign-admin/CampaignCropModal.svelte";
import CampaignModal from "$lib/components/campaigns/CampaignModal.svelte";
import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
import {
	archiveAdminCampaign,
	createAdminCampaign,
	deleteAdminCampaignDraft,
	duplicateAdminCampaign,
	fetchAdminCampaign,
	fetchAdminCampaigns,
	publishAdminCampaign,
	seedFirstRunCampaign,
	updateAdminCampaign,
	type Campaign,
	type CampaignSlide,
	type CampaignSlideDraft,
	type CampaignSlideKind,
	type CampaignStatus,
	type CampaignType,
	type CampaignValidationIssue,
} from "$lib/client/api/campaigns";
import {
	fetchAdminCampaignAsset,
	saveCampaignAssetCrop,
	uploadCampaignAssetSource,
	type CampaignAssetVariant,
	type CampaignAssetCropGeometry,
} from "$lib/client/api/campaign-assets";
import { ApiError } from "$lib/client/api/http";
import { t } from "$lib/i18n";
import type { I18nKey } from "$lib/i18n";
import { reducedMotionAware } from "$lib/utils/motion";
import CampaignDialog from "./campaigns/CampaignDialog.svelte";
import CampaignRail from "./campaigns/CampaignRail.svelte";
import ChecklistStatus from "./campaigns/ChecklistStatus.svelte";
import type { OverflowMenuItem } from "./campaigns/OverflowMenu.svelte";
import OverflowMenu from "./campaigns/OverflowMenu.svelte";
import PerformanceCard from "./campaigns/PerformanceCard.svelte";
import SlideEditor from "./campaigns/SlideEditor.svelte";
import SlideOptionsDialog from "./campaigns/SlideOptionsDialog.svelte";
import SlideRail from "./campaigns/SlideRail.svelte";
import type { SlideRailItem } from "./campaigns/SlideRail.svelte";
import {
	type ChecklistLocale,
	type SlideMenuItem,
	checklistIssueKeys,
	evaluateCampaignChecklist,
	slideHasFailure,
	slideMenuAttention,
} from "./campaigns/campaign-checklist";

const bannerSlide = reducedMotionAware(slideTransitionFn);
const editorFade = reducedMotionAware(fade);

type EditableSlide = CampaignSlide & {
	localId: string;
	kind: CampaignSlideKind;
};

type DraftState = {
	id: string;
	type: CampaignType;
	name: string;
	releaseVersion: string;
	version: Campaign["version"];
	status: CampaignStatus;
	updatedAt: Campaign["updatedAt"];
	createdAt: Campaign["createdAt"];
	publishedAt: Campaign["publishedAt"];
	archivedAt: Campaign["archivedAt"];
	analyticsSummary: Campaign["analyticsSummary"];
	validationErrors: CampaignValidationIssue[];
	slides: EditableSlide[];
};

type CropJob = {
	slideLocalId: string;
	variant: CampaignAssetVariant;
	imageSrc: string;
	/** Revoked on close only when we created the object URL ourselves. */
	revokeOnClose: boolean;
	sourceUpload: Promise<{ id: string }>;
};

type AssetDetails = {
	filename: string;
	sizeBytes: number;
	sourceAssetId: string | null;
};

let campaigns = $state<Campaign[]>([]);
let draft = $state<DraftState | null>(null);
let selectedCampaignId = $state<string | null>(null);
let loading = $state(false);
let detailLoading = $state(false);
let saving = $state(false);
let actionLoading = $state(false);
let assetLoading = $state<string | null>(null);
let errorMessage = $state("");
let successMessage = $state("");
let cropJob = $state<CropJob | null>(null);

let activeSlideIndex = $state(0);
let editLocale = $state<ChecklistLocale>("en");
let previewDevice = $state<"desktop" | "mobile">("desktop");
let showCreateDialog = $state(false);
let showDetailsDialog = $state(false);
let slideOptionsFocus = $state<SlideMenuItem>("layout");
let showSlideOptions = $state(false);
let confirmKind = $state<"delete" | "archive" | null>(null);
let assetDetails = $state<Record<string, AssetDetails | undefined>>({});

const requestedAssetIds = new Set<string>();
let localSlideCounter = 0;

let previewCampaign = $derived<Campaign | null>(
	draft
		? {
				id: draft.id,
				type: draft.type,
				name: draft.name,
				releaseVersion: draft.releaseVersion,
				version: draft.version,
				status: draft.status,
				slides: draft.slides,
			}
		: null,
);

let isDraftEditable = $derived(draft?.status === "draft");
let activeSlide = $derived(draft?.slides[activeSlideIndex] ?? null);

let checklist = $derived(
	evaluateCampaignChecklist({
		type: draft?.type ?? "first_run_onboarding",
		name: draft?.name ?? "",
		releaseVersion: draft?.releaseVersion ?? "",
		slides: (draft?.slides ?? []).map((slide) => ({
			localId: slide.localId,
			id: slide.id,
			kind: slide.kind,
			semanticRole: slide.semanticRole,
			sortOrder: slide.sortOrder,
			titleEn: slide.titleEn,
			titleHu: slide.titleHu,
			bodyEn: slide.bodyEn,
			bodyHu: slide.bodyHu,
			altEn: slide.altEn,
			altHu: slide.altHu,
			actionLabelEn: slide.actionLabelEn,
			actionLabelHu: slide.actionLabelHu,
			actionUrl: slide.actionUrl,
			desktopAssetId: slide.desktopAssetId,
			mobileAssetId: slide.mobileAssetId,
			setupControls: slide.setupControls,
		})),
	}),
);

// The publish gate is exactly the old `publishReadinessIssues()` set, only
// reported per slide/field now. Translated late so the list can be rendered
// wherever it is needed.
let clientValidationErrors = $derived<CampaignValidationIssue[]>(
	draft && isDraftEditable
		? checklistIssueKeys(checklist).map((issue) => ({
				path: issue.path,
				message: $t(issue.messageKey as I18nKey),
			}))
		: [],
);
let serverValidationErrors = $derived(
	clientValidationErrors.length === 0 ? (draft?.validationErrors ?? []) : [],
);

let canSave = $derived(
	Boolean(draft && isDraftEditable && !saving && !detailLoading),
);
let canPublish = $derived(
	Boolean(
		draft &&
			isDraftEditable &&
			clientValidationErrors.length === 0 &&
			!actionLoading &&
			!saving,
	),
);
let canArchive = $derived(
	Boolean(draft?.status === "published" && !actionLoading && !saving),
);
let canDuplicate = $derived(Boolean(draft && !actionLoading && !saving));

let slideRailItems = $derived<SlideRailItem[]>(
	(draft?.slides ?? []).map((slide) => ({
		localId: slide.localId,
		title: slideTitle(slide),
		thumbnailUrl: slide.desktopAssetId
			? `/api/campaign-assets/${encodeURIComponent(slide.desktopAssetId)}/content`
			: slide.mobileAssetId
				? `/api/campaign-assets/${encodeURIComponent(slide.mobileAssetId)}/content`
				: null,
		failing: isDraftEditable && slideHasFailure(checklist, slide.localId),
		isSetup: slide.kind === "setup",
	})),
);

let activeSlideAttention = $derived(
	activeSlide
		? slideMenuAttention(checklist, activeSlide.localId)
		: { layout: false, purpose: false, setupControls: false, any: false },
);

let showPerformance = $derived(
	Boolean(
		draft &&
			(draft.status !== "draft" ||
				(draft.analyticsSummary?.autoShown ?? 0) > 0),
	),
);

function slideLocalId(slide: CampaignSlide) {
	return slide.id ?? `local-slide-${++localSlideCounter}`;
}

function normalizeSlides(slides: CampaignSlide[] = []): EditableSlide[] {
	return [...slides]
		.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
		.map((slide, index) => ({
			...slide,
			localId: slideLocalId(slide),
			kind: (slide.layoutType ??
				slide.kind ??
				slide.type ??
				(index === 0 ? "setup" : "standard")) as CampaignSlideKind,
			sortOrder: slide.sortOrder ?? index + 1,
			semanticRole: slide.semanticRole ?? "feature",
			titleEn: slide.titleEn ?? slide.title?.en ?? "",
			titleHu: slide.titleHu ?? slide.title?.hu ?? "",
			bodyEn: slide.bodyEn ?? slide.body?.en ?? "",
			bodyHu: slide.bodyHu ?? slide.body?.hu ?? "",
			altEn: slide.altEn ?? slide.altText?.en ?? "",
			altHu: slide.altHu ?? slide.altText?.hu ?? "",
			actionLabelEn: slide.actionLabelEn ?? slide.actionLabel?.en ?? "",
			actionLabelHu: slide.actionLabelHu ?? slide.actionLabel?.hu ?? "",
			actionUrl: slide.actionUrl ?? slide.actionDestination ?? "",
			desktopAssetId: slide.desktopAssetId ?? slide.desktopCropAssetId ?? null,
			mobileAssetId: slide.mobileAssetId ?? slide.mobileCropAssetId ?? null,
			setupControls: slide.setupControls ?? [],
		}));
}

function draftFromCampaign(campaign: Campaign): DraftState {
	return {
		id: campaign.id,
		type: campaign.type,
		name: campaign.name ?? "",
		releaseVersion: campaign.releaseVersion ?? "",
		version: campaign.version ?? null,
		status: campaign.status,
		updatedAt: campaign.updatedAt ?? null,
		createdAt: campaign.createdAt ?? null,
		publishedAt: campaign.publishedAt ?? null,
		archivedAt: campaign.archivedAt ?? null,
		analyticsSummary: campaign.analyticsSummary ?? null,
		validationErrors:
			campaign.validationErrors ?? campaign.validationIssues ?? [],
		slides: normalizeSlides(campaign.slides ?? []),
	};
}

function formatDate(value: Campaign["updatedAt"]) {
	if (!value) return $t("admin.campaigns.dateMissing");
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return String(value);
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
		date,
	);
}

function statusLabel(status: CampaignStatus) {
	if (status === "draft") return $t("admin.campaigns.status.draft");
	if (status === "published") return $t("admin.campaigns.status.published");
	if (status === "archived") return $t("admin.campaigns.status.archived");
	return status;
}

function slideKindLabel(kind: CampaignSlideKind) {
	return kind === "setup"
		? $t("admin.campaigns.slideKind.setup")
		: $t("admin.campaigns.slideKind.standard");
}

function slideTitle(slide: EditableSlide) {
	return (
		slide.titleEn?.trim() || slide.titleHu?.trim() || slideKindLabel(slide.kind)
	);
}

function showSuccess(message: string) {
	successMessage = message;
	errorMessage = "";
}

function showError(error: unknown, fallback: string) {
	errorMessage = error instanceof Error ? error.message : fallback;
	successMessage = "";
}

function validationErrorsFromFieldErrors(
	fieldErrors: Record<string, string>,
): CampaignValidationIssue[] {
	return Object.entries(fieldErrors).map(([path, message]) => ({
		path,
		message,
	}));
}

async function loadCampaigns(preferredId: string | null = selectedCampaignId) {
	loading = true;
	errorMessage = "";
	try {
		campaigns = await fetchAdminCampaigns();
		const nextId =
			preferredId && campaigns.some((campaign) => campaign.id === preferredId)
				? preferredId
				: (campaigns[0]?.id ?? null);
		if (nextId) {
			await selectCampaign(nextId, false);
		} else {
			selectedCampaignId = null;
			draft = null;
		}
	} catch (error) {
		showError(error, $t("admin.campaigns.errors.load"));
	} finally {
		loading = false;
	}
}

async function selectCampaign(id: string, clearMessage = true) {
	selectedCampaignId = id;
	detailLoading = true;
	if (clearMessage) {
		errorMessage = "";
		successMessage = "";
	}
	try {
		const campaign = await fetchAdminCampaign(id);
		draft = draftFromCampaign(campaign);
		activeSlideIndex = 0;
	} catch (error) {
		showError(error, $t("admin.campaigns.errors.detail"));
	} finally {
		detailLoading = false;
	}
}

function newSlide(kind: CampaignSlideKind = "standard"): EditableSlide {
	return {
		localId: `new-slide-${++localSlideCounter}`,
		kind,
		semanticRole: "feature",
		sortOrder: draft?.slides.length ?? 0,
		titleEn: "",
		titleHu: "",
		bodyEn: "",
		bodyHu: "",
		altEn: "",
		altHu: "",
		actionLabelEn: "",
		actionLabelHu: "",
		actionUrl: "",
		setupControls: [],
	};
}

function addSlide(kind: CampaignSlideKind = "standard") {
	if (!draft || !isDraftEditable) return;
	draft.slides = [...draft.slides, newSlide(kind)].map((slide, index) => ({
		...slide,
		sortOrder: index + 1,
	}));
	activeSlideIndex = draft.slides.length - 1;
}

function moveSlide(index: number, direction: -1 | 1) {
	if (!draft || !isDraftEditable) return;
	const target = index + direction;
	if (target < 0 || target >= draft.slides.length) return;
	const slides = [...draft.slides];
	const [slide] = slides.splice(index, 1);
	slides.splice(target, 0, slide);
	draft.slides = slides.map((item, itemIndex) => ({
		...item,
		sortOrder: itemIndex + 1,
	}));
	activeSlideIndex = target;
}

function removeSlide(index: number) {
	if (!draft || !isDraftEditable) return;
	draft.slides = draft.slides
		.filter((_, slideIndex) => slideIndex !== index)
		.map((slide, slideIndex) => ({ ...slide, sortOrder: slideIndex + 1 }));
	activeSlideIndex = Math.min(
		activeSlideIndex,
		Math.max(draft.slides.length - 1, 0),
	);
}

function updateSlide(localId: string, patch: Partial<EditableSlide>) {
	if (!draft || !isDraftEditable) return;
	draft.slides = draft.slides.map((slide) =>
		slide.localId === localId ? { ...slide, ...patch } : slide,
	);
}

function copyEnglishToHungarian(localId: string) {
	const slide = draft?.slides.find((item) => item.localId === localId);
	if (!slide) return;
	updateSlide(localId, {
		titleHu: slide.titleEn ?? "",
		bodyHu: slide.bodyEn ?? "",
		altHu: slide.altEn ?? "",
		actionLabelHu: slide.actionLabelEn ?? "",
	});
	editLocale = "hu";
}

function slidePayload(): CampaignSlideDraft[] {
	return (draft?.slides ?? []).map((slide, sortOrder) => ({
		id: slide.id,
		kind: slide.kind,
		layoutType: slide.kind,
		semanticRole: slide.semanticRole ?? "feature",
		sortOrder: sortOrder + 1,
		title: { en: slide.titleEn ?? "", hu: slide.titleHu ?? "" },
		titleEn: slide.titleEn ?? "",
		titleHu: slide.titleHu ?? "",
		body: { en: slide.bodyEn ?? "", hu: slide.bodyHu ?? "" },
		bodyEn: slide.bodyEn ?? "",
		bodyHu: slide.bodyHu ?? "",
		altText: { en: slide.altEn ?? "", hu: slide.altHu ?? "" },
		altEn: slide.altEn ?? "",
		altHu: slide.altHu ?? "",
		actionLabel: {
			en: slide.actionLabelEn ?? "",
			hu: slide.actionLabelHu ?? "",
		},
		actionLabelEn: slide.actionLabelEn ?? "",
		actionLabelHu: slide.actionLabelHu ?? "",
		actionDestination: slide.actionUrl ?? "",
		actionUrl: slide.actionUrl ?? "",
		desktopCropAssetId: slide.desktopAssetId ?? null,
		desktopAssetId: slide.desktopAssetId ?? null,
		mobileCropAssetId: slide.mobileAssetId ?? null,
		mobileAssetId: slide.mobileAssetId ?? null,
		desktopSourceAssetId: slide.desktopSourceAssetId ?? null,
		mobileSourceAssetId: slide.mobileSourceAssetId ?? null,
		setupControls: slide.setupControls ?? [],
	}));
}

function campaignPayload() {
	if (!draft) return null;
	return {
		name: draft.name.trim() || null,
		type: draft.type,
		releaseVersion: draft.releaseVersion.trim() || null,
		slides: slidePayload(),
	};
}

async function saveDraft() {
	if (!draft || !isDraftEditable) return;
	saving = true;
	try {
		const payload = campaignPayload();
		if (!payload) return;
		const campaign = await updateAdminCampaign(draft.id, payload);
		draft = draftFromCampaign({
			...campaign,
			validationErrors: campaign.validationErrors ?? draft.validationErrors,
		});
		campaigns = campaigns.map((item) =>
			item.id === campaign.id ? { ...item, ...campaign } : item,
		);
		showSuccess($t("admin.campaigns.messages.saved"));
	} catch (error) {
		showError(error, $t("admin.campaigns.errors.save"));
	} finally {
		saving = false;
	}
}

async function createCampaign(values: {
	name: string;
	type: CampaignType;
	releaseVersion: string;
}) {
	actionLoading = true;
	try {
		const campaign = await createAdminCampaign({
			type: values.type,
			name: values.name.trim() || null,
			releaseVersion: values.releaseVersion.trim() || null,
		});
		showCreateDialog = false;
		showSuccess($t("admin.campaigns.messages.created"));
		await loadCampaigns(campaign.id);
	} catch (error) {
		showError(error, $t("admin.campaigns.errors.create"));
	} finally {
		actionLoading = false;
	}
}

function saveDetails(values: {
	name: string;
	type: CampaignType;
	releaseVersion: string;
}) {
	if (!draft || !isDraftEditable) return;
	draft.name = values.name;
	draft.type = values.type;
	draft.releaseVersion = values.releaseVersion;
	showDetailsDialog = false;
}

async function seedFirstRun() {
	actionLoading = true;
	try {
		const result = await seedFirstRunCampaign();
		showSuccess(
			result.created
				? $t("admin.campaigns.messages.seeded")
				: $t("admin.campaigns.messages.seedExists"),
		);
		await loadCampaigns(result.campaign.id);
	} catch (error) {
		showError(error, $t("admin.campaigns.errors.seed"));
	} finally {
		actionLoading = false;
	}
}

async function publishCampaign() {
	if (!draft || !isDraftEditable || clientValidationErrors.length > 0) return;
	actionLoading = true;
	try {
		const payload = campaignPayload();
		if (!payload) return;
		const saved = await updateAdminCampaign(draft.id, payload);
		const campaign = await publishAdminCampaign(saved.id);
		draft = draftFromCampaign({
			...campaign,
			validationErrors: campaign.validationErrors ?? [],
		});
		campaigns = campaigns.map((item) =>
			item.id === campaign.id ? { ...item, ...campaign } : item,
		);
		if (campaign.type === "release_update") {
			await invalidateAll();
		}
		showSuccess($t("admin.campaigns.messages.published"));
	} catch (error) {
		if (error instanceof ApiError && error.fieldErrors && draft) {
			draft.validationErrors = validationErrorsFromFieldErrors(
				error.fieldErrors,
			);
		}
		showError(error, $t("admin.campaigns.errors.publish"));
	} finally {
		actionLoading = false;
	}
}

async function archiveCampaign() {
	if (!draft) return;
	actionLoading = true;
	try {
		const campaign = await archiveAdminCampaign(draft.id);
		draft = draftFromCampaign(campaign);
		campaigns = campaigns.map((item) =>
			item.id === campaign.id ? { ...item, ...campaign } : item,
		);
		showSuccess($t("admin.campaigns.messages.archived"));
	} catch (error) {
		showError(error, $t("admin.campaigns.errors.archive"));
	} finally {
		actionLoading = false;
	}
}

async function deleteDraft() {
	if (!draft) return;
	actionLoading = true;
	try {
		await deleteAdminCampaignDraft(draft.id);
		const deletedId = draft.id;
		draft = null;
		selectedCampaignId = null;
		showSuccess($t("admin.campaigns.messages.deleted"));
		await loadCampaigns(
			campaigns.find((item) => item.id !== deletedId)?.id ?? null,
		);
	} catch (error) {
		showError(error, $t("admin.campaigns.errors.delete"));
	} finally {
		actionLoading = false;
	}
}

function confirmDestructive() {
	const kind = confirmKind;
	confirmKind = null;
	if (kind === "delete") void deleteDraft();
	if (kind === "archive") void archiveCampaign();
}

async function duplicateCampaign() {
	if (!draft) return;
	actionLoading = true;
	try {
		const campaign = await duplicateAdminCampaign(draft.id);
		showSuccess($t("admin.campaigns.messages.duplicated"));
		await loadCampaigns(campaign.id);
	} catch (error) {
		showError(error, $t("admin.campaigns.errors.duplicate"));
	} finally {
		actionLoading = false;
	}
}

function assetIdFor(slide: EditableSlide, variant: CampaignAssetVariant) {
	return variant === "desktop" ? slide.desktopAssetId : slide.mobileAssetId;
}

function sourceIdFor(slide: EditableSlide, variant: CampaignAssetVariant) {
	const local =
		variant === "desktop"
			? slide.desktopSourceAssetId
			: slide.mobileSourceAssetId;
	if (local) return local;
	const cropId = assetIdFor(slide, variant);
	return cropId ? (assetDetails[cropId]?.sourceAssetId ?? null) : null;
}

function startCrop(
	slideLocalId: string,
	variant: CampaignAssetVariant,
	file: File,
) {
	if (!isDraftEditable) return;
	const loadingKey = `${slideLocalId}:${variant}`;
	const imageSrc = URL.createObjectURL(file);
	const sourceUpload = uploadCampaignAssetSource({ image: file });
	assetLoading = loadingKey;
	sourceUpload
		.catch((error) => {
			showError(error, $t("admin.campaigns.errors.assetUpload"));
		})
		.finally(() => {
			if (assetLoading === loadingKey) assetLoading = null;
		});
	cropJob = {
		slideLocalId,
		variant,
		imageSrc,
		revokeOnClose: true,
		sourceUpload,
	};
}

/**
 * Re-crop keeps the original upload: the crop row remembers the source it was
 * cut from, so the dialog reopens on the untouched image instead of asking for
 * the file again.
 */
function recropAsset(slideLocalId: string, variant: CampaignAssetVariant) {
	if (!isDraftEditable) return;
	const slide = draft?.slides.find((item) => item.localId === slideLocalId);
	if (!slide) return;
	const sourceId = sourceIdFor(slide, variant);
	if (!sourceId) return;
	cropJob = {
		slideLocalId,
		variant,
		imageSrc: `/api/campaign-assets/${encodeURIComponent(sourceId)}/content`,
		revokeOnClose: false,
		sourceUpload: Promise.resolve({ id: sourceId }),
	};
}

function removeAsset(slideLocalId: string, variant: CampaignAssetVariant) {
	updateSlide(
		slideLocalId,
		variant === "desktop"
			? { desktopAssetId: null, desktopSourceAssetId: null }
			: { mobileAssetId: null, mobileSourceAssetId: null },
	);
}

function attachCrop(
	slideLocalId: string,
	variant: CampaignAssetVariant,
	sourceAssetId: string,
	cropAssetId: string,
) {
	updateSlide(
		slideLocalId,
		variant === "desktop"
			? { desktopAssetId: cropAssetId, desktopSourceAssetId: sourceAssetId }
			: { mobileAssetId: cropAssetId, mobileSourceAssetId: sourceAssetId },
	);
}

async function saveCrop(payload: {
	file: File;
	width: number;
	height: number;
	crop: CampaignAssetCropGeometry;
}) {
	if (!cropJob) return;
	const activeCrop = cropJob;
	const source = await activeCrop.sourceUpload;
	const crop = await saveCampaignAssetCrop({
		sourceAssetId: source.id,
		variant: activeCrop.variant,
		image: payload.file,
		width: payload.width,
		height: payload.height,
		crop: payload.crop,
	});
	attachCrop(activeCrop.slideLocalId, activeCrop.variant, source.id, crop.id);
	if (activeCrop.revokeOnClose) URL.revokeObjectURL(activeCrop.imageSrc);
	cropJob = null;
}

function cancelCrop() {
	if (cropJob?.revokeOnClose) URL.revokeObjectURL(cropJob.imageSrc);
	cropJob = null;
}

function openSlideOptions(focus: SlideMenuItem) {
	slideOptionsFocus = focus;
	showSlideOptions = true;
}

let campaignMenuItems = $derived.by<OverflowMenuItem[]>(() => {
	const items: OverflowMenuItem[] = [
		{
			id: "duplicate",
			label: $t("admin.campaigns.duplicateAsDraft"),
			icon: Copy,
			disabled: !canDuplicate,
			onSelect: () => void duplicateCampaign(),
		},
	];
	if (draft?.status === "published") {
		items.push({
			id: "archive",
			label: $t("admin.campaigns.archive"),
			icon: Archive,
			disabled: !canArchive,
			onSelect: () => {
				confirmKind = "archive";
			},
		});
	}
	items.push({
		id: "seed",
		label: $t("admin.campaigns.seedFirstRun"),
		icon: FlaskConical,
		disabled: actionLoading,
		onSelect: () => void seedFirstRun(),
	});
	if (isDraftEditable) {
		items.push({
			id: "delete",
			label: $t("admin.campaigns.deleteDraft"),
			icon: Trash2,
			danger: true,
			separatorBefore: true,
			// Deliberately not gated on validation: the drafts you most want to
			// throw away are exactly the ones that fail it.
			disabled: actionLoading || saving,
			onSelect: () => {
				confirmKind = "delete";
			},
		});
	}
	return items;
});

let slideMenuItems = $derived<OverflowMenuItem[]>(
	activeSlide
		? [
				{
					id: "layout",
					label: $t("admin.campaigns.menu.layout", {
						value: slideKindLabel(activeSlide.kind),
					}),
					icon: Layers,
					attention: activeSlideAttention.layout,
					disabled: !isDraftEditable,
					onSelect: () => openSlideOptions("layout"),
				},
				{
					id: "purpose",
					label: $t("admin.campaigns.menu.purpose", {
						value:
							activeSlide.semanticRole === "data_disclosure"
								? $t("admin.campaigns.purpose.dataDisclosure")
								: $t("admin.campaigns.purpose.feature"),
					}),
					icon: Flag,
					attention: activeSlideAttention.purpose,
					disabled: !isDraftEditable,
					onSelect: () => openSlideOptions("purpose"),
				},
				{
					id: "setupControls",
					label: $t("admin.campaigns.menu.setupControls", {
						count: activeSlide.setupControls?.length ?? 0,
					}),
					icon: SlidersHorizontal,
					attention: activeSlideAttention.setupControls,
					disabled: !isDraftEditable,
					onSelect: () => openSlideOptions("setupControls"),
				},
				{
					id: "copy",
					label: $t("admin.campaigns.menu.copyEnToHu"),
					icon: Copy,
					separatorBefore: true,
					disabled: !isDraftEditable,
					onSelect: () => copyEnglishToHungarian(activeSlide.localId),
				},
				{
					id: "up",
					label: $t("admin.campaigns.menu.moveUp"),
					icon: ArrowUp,
					disabled: !isDraftEditable || activeSlideIndex === 0,
					onSelect: () => moveSlide(activeSlideIndex, -1),
				},
				{
					id: "down",
					label: $t("admin.campaigns.menu.moveDown"),
					icon: ArrowDown,
					disabled:
						!isDraftEditable ||
						activeSlideIndex >= (draft?.slides.length ?? 0) - 1,
					onSelect: () => moveSlide(activeSlideIndex, 1),
				},
				{
					id: "delete-slide",
					label: $t("admin.campaigns.menu.deleteSlide"),
					icon: Trash2,
					danger: true,
					separatorBefore: true,
					disabled: !isDraftEditable,
					onSelect: () => removeSlide(activeSlideIndex),
				},
			]
		: [],
);

let metaLine = $derived.by(() => {
	if (!draft) return "";
	const parts: string[] = [
		draft.type === "first_run_onboarding"
			? $t("admin.campaigns.type.firstRun")
			: $t("admin.campaigns.type.release"),
	];
	if (draft.releaseVersion) parts.push(draft.releaseVersion);
	parts.push($t("admin.campaigns.slideCount", { count: draft.slides.length }));
	if (draft.status === "published" && draft.publishedAt) {
		parts.push(
			$t("admin.campaigns.liveSince", { date: formatDate(draft.publishedAt) }),
		);
	} else if (draft.status === "archived" && draft.archivedAt) {
		parts.push(
			$t("admin.campaigns.archivedOn", { date: formatDate(draft.archivedAt) }),
		);
	} else if (draft.updatedAt) {
		parts.push(
			$t("admin.campaigns.updatedOn", { date: formatDate(draft.updatedAt) }),
		);
	}
	return parts.join(" · ");
});

// Names and sizes for the attached screenshots of the open slide. Fetched once
// per asset id; the ids come from the draft, never from `assetDetails` itself,
// so writing the result cannot re-trigger this effect.
$effect(() => {
	const ids = [activeSlide?.desktopAssetId, activeSlide?.mobileAssetId].filter(
		(id): id is string => Boolean(id),
	);
	for (const id of ids) {
		if (requestedAssetIds.has(id)) continue;
		requestedAssetIds.add(id);
		void fetchAdminCampaignAsset(id)
			.then((asset) => {
				assetDetails = {
					...assetDetails,
					[id]: {
						filename: asset.originalFilename,
						sizeBytes: asset.sizeBytes,
						sourceAssetId: asset.sourceAssetId ?? null,
					},
				};
			})
			.catch(() => {
				// Metadata is a nicety: the editor still works without it.
				requestedAssetIds.delete(id);
			});
	}
});

onMount(() => {
	void loadCampaigns();
});
</script>

<section class="campaigns-pane" aria-labelledby="admin-campaigns-heading">
	<h2 id="admin-campaigns-heading" class="sr-only">{$t('admin.campaigns.title')}</h2>

	{#if errorMessage}
		<p class="banner banner-danger" role="alert">{errorMessage}</p>
	{/if}
	{#if successMessage}
		<p class="banner banner-success" role="status">{successMessage}</p>
	{/if}

	<div class="workbench">
		<div class="area-campaigns">
			<CampaignRail
				{campaigns}
				{selectedCampaignId}
				{loading}
				busy={actionLoading}
				onSelect={(id) => void selectCampaign(id)}
				onCreate={() => (showCreateDialog = true)}
			/>
		</div>

		<div class="area-slides">
			{#if draft}
				<SlideRail
					slides={slideRailItems}
					activeIndex={activeSlideIndex}
					editable={isDraftEditable}
					onSelect={(index) => (activeSlideIndex = index)}
					onAdd={() => addSlide('standard')}
				/>
			{/if}
		</div>

		<div class="area-editor">
			{#if detailLoading && !draft}
				<p class="pane-note">{$t('admin.campaigns.loadingDetail')}</p>
			{:else if draft}
				<div class="editor-head">
					<div class="editor-title-block">
						<div class="editor-title-row">
							<h3 class="editor-title">{draft.name || $t('campaignModal.untitled')}</h3>
							<span
								class="pill"
								class:pill-accent={draft.status === 'draft'}
								class:pill-success={draft.status === 'published'}
								class:pill-muted={draft.status === 'archived'}
							>
								{statusLabel(draft.status)}
							</span>
						</div>
						<p class="editor-meta">
							<span>{metaLine}</span>
							{#if isDraftEditable}
								<button
									type="button"
									class="icon-btn"
									aria-label={$t('admin.campaigns.editDetailsTitle')}
									title={$t('admin.campaigns.editDetailsTitle')}
									onclick={() => (showDetailsDialog = true)}
								>
									<Pencil size={11} strokeWidth={2} aria-hidden="true" />
								</button>
							{/if}
						</p>
					</div>

					<div class="editor-actions">
						{#if isDraftEditable}
							<button type="button" class="btn-secondary" disabled={!canSave} onclick={saveDraft}>
								{saving ? $t('common.saving') : $t('admin.campaigns.saveDraft')}
							</button>
							<OverflowMenu
								label={$t('admin.campaigns.campaignMenuLabel')}
								triggerLabel={$t('admin.campaigns.campaignMenuTrigger')}
								items={campaignMenuItems}
								testId="campaign-menu"
							/>
							<button type="button" class="btn-primary" disabled={!canPublish} onclick={publishCampaign}>
								{$t('admin.campaigns.publish')}
							</button>
						{:else}
							<button
								type="button"
								class="btn-primary gap-1.5"
								disabled={!canDuplicate}
								onclick={duplicateCampaign}
							>
								<Copy size={14} strokeWidth={2} aria-hidden="true" />
								{$t('admin.campaigns.duplicateAsDraft')}
							</button>
							<OverflowMenu
								label={$t('admin.campaigns.campaignMenuLabel')}
								triggerLabel={$t('admin.campaigns.campaignMenuTrigger')}
								items={campaignMenuItems}
								testId="campaign-menu"
							/>
						{/if}
					</div>
				</div>

				{#if !isDraftEditable}
					<p class="banner banner-warning" transition:bannerSlide={{ duration: 180 }}>
						<Lock size={14} strokeWidth={2} aria-hidden="true" />
						{draft.status === 'archived'
							? $t('admin.campaigns.archivedReadOnly')
							: $t('admin.campaigns.publishedReadOnly')}
					</p>
				{:else}
					<ChecklistStatus
						{checklist}
						onJumpToSlide={(index) => (activeSlideIndex = index)}
					/>
				{/if}

				{#if serverValidationErrors.length > 0}
					<div class="banner banner-danger" role="alert">
						<TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
						<span>
							{$t('admin.campaigns.serverIssues')}
							<ul class="server-issues">
								{#each serverValidationErrors as issue (issue.path ?? issue.message)}
									<li>{issue.message}</li>
								{/each}
							</ul>
						</span>
					</div>
				{/if}

				{#if activeSlide}
					{@const slide = activeSlide}
					<!-- Keyed on the slide so opening another one swaps the editor; the
					     incoming card fades in, and there is deliberately no outgoing
					     transition, which would briefly stack two cards and jump the
					     page height. -->
					{#key slide.localId}
						<div in:editorFade={{ duration: 140 }}>
						<SlideEditor
							{slide}
							slideNumber={activeSlideIndex + 1}
							locale={editLocale}
							editable={isDraftEditable}
							{checklist}
							menuItems={slideMenuItems}
							menuAttention={activeSlideAttention.any}
							{assetDetails}
							uploadingVariant={assetLoading === `${slide.localId}:desktop`
								? 'desktop'
								: assetLoading === `${slide.localId}:mobile`
									? 'mobile'
									: null}
							onUpdate={(patch) => updateSlide(slide.localId, patch)}
							onLocaleChange={(next) => (editLocale = next)}
							onAssetUpload={(variant, file) => startCrop(slide.localId, variant, file)}
							onAssetRecrop={(variant) => recropAsset(slide.localId, variant)}
							onAssetRemove={(variant) => removeAsset(slide.localId, variant)}
						/>
						</div>
					{/key}
				{:else}
					<p class="pane-note">{$t('admin.campaigns.noSlides')}</p>
				{/if}
			{:else}
				<p class="pane-note">{$t('admin.campaigns.selectCampaign')}</p>
			{/if}
		</div>

		<div class="area-preview">
			{#if draft}
				<section class="preview-card" aria-label={$t('admin.campaigns.previewLabel')}>
					<div class="preview-head">
						<p class="eyebrow">{$t('admin.campaigns.preview')}</p>
						<div class="device-toggle" role="group" aria-label={$t('admin.campaigns.previewDevice')}>
							<button
								type="button"
								class="device-btn"
								class:device-btn-active={previewDevice === 'desktop'}
								aria-pressed={previewDevice === 'desktop'}
								aria-label={$t('admin.campaigns.previewDesktop')}
								title={$t('admin.campaigns.previewDesktop')}
								onclick={() => (previewDevice = 'desktop')}
							>
								<Monitor size={12} strokeWidth={2} aria-hidden="true" />
							</button>
							<button
								type="button"
								class="device-btn"
								class:device-btn-active={previewDevice === 'mobile'}
								aria-pressed={previewDevice === 'mobile'}
								aria-label={$t('admin.campaigns.previewMobile')}
								title={$t('admin.campaigns.previewMobile')}
								onclick={() => (previewDevice = 'mobile')}
							>
								<Smartphone size={12} strokeWidth={2} aria-hidden="true" />
							</button>
						</div>
					</div>
					<div class="preview-frame" class:preview-frame-mobile={previewDevice === 'mobile'}>
						<CampaignModal
							campaign={previewCampaign}
							locale={editLocale}
							preview={true}
							inline={true}
							slideIndex={activeSlideIndex}
							onSlideChange={(index) => (activeSlideIndex = index)}
						/>
					</div>
				</section>

				{#if showPerformance}
					<PerformanceCard
						summary={draft.analyticsSummary}
						slideCount={draft.slides.length}
						createdAt={draft.createdAt}
						updatedAt={draft.updatedAt}
						publishedAt={draft.publishedAt}
					/>
				{/if}
			{/if}
		</div>
	</div>
</section>

{#if showCreateDialog}
	<CampaignDialog
		mode="create"
		busy={actionLoading}
		onConfirm={createCampaign}
		onCancel={() => (showCreateDialog = false)}
	/>
{/if}

{#if showDetailsDialog && draft}
	<CampaignDialog
		mode="edit"
		name={draft.name}
		type={draft.type}
		releaseVersion={draft.releaseVersion}
		onConfirm={saveDetails}
		onCancel={() => (showDetailsDialog = false)}
	/>
{/if}

{#if showSlideOptions && activeSlide && draft}
	{@const slide = activeSlide}
	<SlideOptionsDialog
		slideNumber={activeSlideIndex + 1}
		kind={slide.kind}
		semanticRole={slide.semanticRole}
		setupControls={slide.setupControls ?? []}
		campaignType={draft.type}
		editable={isDraftEditable}
		attention={activeSlideAttention}
		focus={slideOptionsFocus}
		onChangeKind={(kind) => updateSlide(slide.localId, { kind })}
		onChangeRole={(semanticRole) => updateSlide(slide.localId, { semanticRole })}
		onChangeSetupControls={(setupControls) =>
			updateSlide(slide.localId, { setupControls })}
		onClose={() => (showSlideOptions = false)}
	/>
{/if}

{#if confirmKind}
	<ConfirmDialog
		title={confirmKind === 'delete'
			? $t('admin.campaigns.deleteDraft')
			: $t('admin.campaigns.archive')}
		message={confirmKind === 'delete'
			? $t('admin.campaigns.deleteDraftConfirm')
			: $t('admin.campaigns.archiveConfirm')}
		confirmText={confirmKind === 'delete'
			? $t('admin.campaigns.deleteDraft')
			: $t('admin.campaigns.archive')}
		confirmVariant="danger"
		onCancel={() => (confirmKind = null)}
		onConfirm={confirmDestructive}
	/>
{/if}

{#if cropJob}
	<CampaignCropModal
		imageSrc={cropJob.imageSrc}
		variant={cropJob.variant}
		ratio={cropJob.variant === 'desktop' ? 16 / 10 : 9 / 16}
		title={$t('admin.campaigns.cropTitle')}
		metadata={$t('admin.campaigns.cropMetadata', {
			number: activeSlideIndex + 1,
			ratio: cropJob.variant === 'desktop' ? '16:10' : '9:16',
			size: cropJob.variant === 'desktop' ? '1600 × 1000' : '1080 × 1920',
		})}
		onSave={saveCrop}
		onCancel={cancelCrop}
	/>
{/if}

<style>
	.campaigns-pane {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		min-width: 0;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border-width: 0;
	}

	.workbench {
		display: grid;
		gap: var(--space-md);
		align-items: start;
		min-width: 0;
		grid-template-columns: minmax(0, 1fr);
		grid-template-areas:
			"campaigns"
			"slides"
			"editor"
			"preview";
	}

	@media (min-width: 1024px) {
		.workbench {
			grid-template-columns: 190px 152px minmax(0, 1fr);
			grid-template-areas:
				"campaigns slides editor"
				"preview preview preview";
		}
	}

	@media (min-width: 1440px) {
		.workbench {
			grid-template-columns: 190px 152px minmax(0, 1fr) 360px;
			grid-template-areas: "campaigns slides editor preview";
		}
	}

	.area-campaigns {
		grid-area: campaigns;
		min-width: 0;
	}

	.area-slides {
		grid-area: slides;
		min-width: 0;
	}

	.area-editor {
		grid-area: editor;
		min-width: 0;
	}

	.area-preview {
		grid-area: preview;
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		min-width: 0;
	}

	.pane-note {
		padding: var(--space-md);
		font-size: var(--text-md);
		color: var(--text-muted);
	}

	.editor-head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 0.625rem;
		margin-bottom: 0.875rem;
	}

	.editor-title-block {
		flex: 1 1 16rem;
		min-width: 0;
	}

	.editor-title-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.editor-title {
		font-size: 1.0625rem;
		font-weight: 600;
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}

	.editor-meta {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-top: 4px;
		font-size: var(--text-2xs);
		color: var(--text-muted);
	}

	.editor-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}

	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 22px;
		min-width: 22px;
		padding: 0 5px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--surface-page);
		color: var(--text-muted);
		cursor: pointer;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.icon-btn:hover {
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		color: var(--accent);
	}

	.icon-btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.banner {
		display: flex;
		align-items: flex-start;
		gap: 0.55rem;
		padding: 0.65rem 0.875rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		font-size: var(--text-xs);
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.banner-danger {
		border-color: color-mix(in srgb, var(--danger) 30%, transparent);
		background: color-mix(in srgb, var(--danger) 10%, var(--surface-page));
		color: var(--danger);
		margin-bottom: 0.75rem;
	}

	.banner-success {
		border-color: color-mix(in srgb, var(--success) 30%, transparent);
		background: color-mix(in srgb, var(--success) 10%, var(--surface-page));
		color: var(--success);
	}

	.banner-warning {
		border-color: color-mix(in srgb, var(--warning) 35%, transparent);
		background: color-mix(in srgb, var(--warning) 8%, var(--surface-page));
		color: var(--text-secondary);
		margin-bottom: 0.75rem;
	}

	.banner-warning :global(svg) {
		color: var(--warning);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.server-issues {
		margin-top: 0.25rem;
		padding-left: 1rem;
		list-style: disc;
	}

	.preview-card {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--surface-overlay);
		padding: 0.875rem 1rem;
	}

	.preview-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.625rem;
	}

	.eyebrow {
		flex: 1 1 auto;
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
	}

	.device-toggle {
		display: inline-flex;
		gap: 0.25rem;
	}

	.device-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--surface-page);
		color: var(--text-muted);
		cursor: pointer;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.device-btn:hover {
		color: var(--text-primary);
	}

	.device-btn-active {
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 40%, transparent);
	}

	.device-btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* The preview is the real user-facing modal, which draws its own card, so
	   this wrapper only sizes it: full width on desktop, phone-width when the
	   device toggle asks for it. */
	.preview-frame {
		transition: max-width var(--duration-emphasis) var(--ease-out);
		max-width: 100%;
		margin: 0 auto;
	}

	.preview-frame-mobile {
		max-width: 320px;
	}

	.pill {
		display: inline-flex;
		align-items: center;
		padding: 1px 8px;
		border-radius: var(--radius-full);
		font-size: 0.7rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.pill-accent {
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
	}

	.pill-success {
		color: var(--success);
		background: color-mix(in srgb, var(--success) 16%, transparent);
	}

	.pill-muted {
		color: var(--text-muted);
		background: color-mix(in srgb, var(--text-muted) 16%, transparent);
	}
</style>
