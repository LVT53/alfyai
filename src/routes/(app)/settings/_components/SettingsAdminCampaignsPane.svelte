<script lang="ts">
	import { onMount } from 'svelte';
	import CampaignCropModal from '$lib/components/campaign-admin/CampaignCropModal.svelte';
	import CampaignModal from '$lib/components/campaigns/CampaignModal.svelte';
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
	} from '$lib/client/api/campaigns';
	import {
		saveCampaignAssetCrop,
		uploadCampaignAssetSource,
		type CampaignAssetVariant,
		type CampaignAssetCropGeometry,
	} from '$lib/client/api/campaign-assets';
	import { t } from '$lib/i18n';

	type EditableSlide = CampaignSlide & {
		localId: string;
		kind: CampaignSlideKind;
	};

	type DraftState = {
		id: string;
		type: CampaignType;
		name: string;
		releaseVersion: string;
		version: Campaign['version'];
		status: CampaignStatus;
		updatedAt: Campaign['updatedAt'];
		createdAt: Campaign['createdAt'];
		publishedAt: Campaign['publishedAt'];
		archivedAt: Campaign['archivedAt'];
		analyticsSummary: Campaign['analyticsSummary'];
		validationErrors: CampaignValidationIssue[];
		slides: EditableSlide[];
	};

	type CropJob = {
		slideLocalId: string;
		variant: CampaignAssetVariant;
		sourceAssetId: string;
		imageSrc: string;
	};

	let campaigns = $state<Campaign[]>([]);
	let draft = $state<DraftState | null>(null);
	let selectedCampaignId = $state<string | null>(null);
	let loading = $state(false);
	let detailLoading = $state(false);
	let saving = $state(false);
	let actionLoading = $state(false);
	let assetLoading = $state<string | null>(null);
	let errorMessage = $state('');
	let successMessage = $state('');
	let createName = $state('');
	let createType = $state<CampaignType>('first_run_onboarding');
	let createReleaseVersion = $state('');
	let previewLocale = $state<'en' | 'hu'>('en');
	let previewSlideIndex = $state(0);
	let cropJob = $state<CropJob | null>(null);

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

	let validationErrors = $derived(draft?.validationErrors ?? []);
	let isDraftEditable = $derived(draft?.status === 'draft');
	let canSave = $derived(Boolean(draft && isDraftEditable && !saving && !detailLoading));
	let canPublish = $derived(Boolean(draft && isDraftEditable && !actionLoading && !saving));
	let canArchive = $derived(Boolean(draft?.status === 'published' && !actionLoading && !saving));
	let canDuplicate = $derived(Boolean(draft && !actionLoading && !saving));

	function slideLocalId(slide: CampaignSlide) {
		return slide.id ?? `local-slide-${++localSlideCounter}`;
	}

	function normalizeSlides(slides: CampaignSlide[] = []): EditableSlide[] {
		return [...slides]
			.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
			.map((slide, index) => ({
				...slide,
				localId: slideLocalId(slide),
				kind: (slide.layoutType ?? slide.kind ?? slide.type ?? (index === 0 ? 'setup' : 'standard')) as CampaignSlideKind,
				sortOrder: slide.sortOrder ?? index + 1,
				semanticRole: slide.semanticRole ?? 'feature',
				titleEn: slide.titleEn ?? slide.title?.en ?? '',
				titleHu: slide.titleHu ?? slide.title?.hu ?? '',
				bodyEn: slide.bodyEn ?? slide.body?.en ?? '',
				bodyHu: slide.bodyHu ?? slide.body?.hu ?? '',
				altEn: slide.altEn ?? slide.altText?.en ?? '',
				altHu: slide.altHu ?? slide.altText?.hu ?? '',
				actionLabelEn: slide.actionLabelEn ?? slide.actionLabel?.en ?? '',
				actionLabelHu: slide.actionLabelHu ?? slide.actionLabel?.hu ?? '',
				actionUrl: slide.actionUrl ?? slide.actionDestination ?? '',
				desktopAssetId: slide.desktopAssetId ?? slide.desktopCropAssetId ?? null,
				mobileAssetId: slide.mobileAssetId ?? slide.mobileCropAssetId ?? null,
				setupControls: slide.setupControls ?? [],
			}));
	}

	function draftFromCampaign(campaign: Campaign): DraftState {
		return {
			id: campaign.id,
			type: campaign.type,
			name: campaign.name ?? '',
			releaseVersion: campaign.releaseVersion ?? '',
			version: campaign.version ?? null,
			status: campaign.status,
			updatedAt: campaign.updatedAt ?? null,
			createdAt: campaign.createdAt ?? null,
			publishedAt: campaign.publishedAt ?? null,
			archivedAt: campaign.archivedAt ?? null,
			analyticsSummary: campaign.analyticsSummary ?? null,
			validationErrors: campaign.validationErrors ?? campaign.validationIssues ?? [],
			slides: normalizeSlides(campaign.slides ?? []),
		};
	}

	function fallbackCampaignName(campaign: Campaign) {
		return campaign.name?.trim() || `${campaign.type} v${campaign.version ?? 1}`;
	}

	function formatDate(value: Campaign['updatedAt']) {
		if (!value) return $t('admin.campaigns.dateMissing');
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return String(value);
		return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
	}

	function statusLabel(status: CampaignStatus) {
		if (status === 'draft') return $t('admin.campaigns.status.draft');
		if (status === 'published') return $t('admin.campaigns.status.published');
		if (status === 'archived') return $t('admin.campaigns.status.archived');
		return status;
	}

	function slideKindLabel(kind: CampaignSlideKind) {
		return kind === 'setup' ? $t('admin.campaigns.slideKind.setup') : $t('admin.campaigns.slideKind.standard');
	}

	function slideTitle(slide: EditableSlide) {
		return slide.titleEn?.trim() || slide.titleHu?.trim() || slideKindLabel(slide.kind);
	}

	function showSuccess(message: string) {
		successMessage = message;
		errorMessage = '';
	}

	function showError(error: unknown, fallback: string) {
		errorMessage = error instanceof Error ? error.message : fallback;
		successMessage = '';
	}

	async function loadCampaigns(preferredId: string | null = selectedCampaignId) {
		loading = true;
		errorMessage = '';
		try {
			campaigns = await fetchAdminCampaigns();
			const nextId = preferredId && campaigns.some((campaign) => campaign.id === preferredId)
				? preferredId
				: campaigns[0]?.id ?? null;
			if (nextId) {
				await selectCampaign(nextId, false);
			} else {
				selectedCampaignId = null;
				draft = null;
			}
		} catch (error) {
			showError(error, $t('admin.campaigns.errors.load'));
		} finally {
			loading = false;
		}
	}

	async function selectCampaign(id: string, clearMessage = true) {
		selectedCampaignId = id;
		detailLoading = true;
		if (clearMessage) {
			errorMessage = '';
			successMessage = '';
		}
		try {
			const campaign = await fetchAdminCampaign(id);
			draft = draftFromCampaign(campaign);
			previewSlideIndex = 0;
		} catch (error) {
			showError(error, $t('admin.campaigns.errors.detail'));
		} finally {
			detailLoading = false;
		}
	}

	function newSlide(kind: CampaignSlideKind = 'standard'): EditableSlide {
		return {
			localId: `new-slide-${++localSlideCounter}`,
			kind,
			sortOrder: draft?.slides.length ?? 0,
			titleEn: '',
			titleHu: '',
			bodyEn: '',
			bodyHu: '',
			altEn: '',
			altHu: '',
			actionLabelEn: '',
			actionLabelHu: '',
			actionUrl: '',
		};
	}

	function addSlide(kind: CampaignSlideKind) {
		if (!draft || !isDraftEditable) return;
		draft.slides = [...draft.slides, newSlide(kind)].map((slide, index) => ({ ...slide, sortOrder: index + 1 }));
		previewSlideIndex = draft.slides.length - 1;
	}

	function moveSlide(index: number, direction: -1 | 1) {
		if (!draft || !isDraftEditable) return;
		const target = index + direction;
		if (target < 0 || target >= draft.slides.length) return;
		const slides = [...draft.slides];
		const [slide] = slides.splice(index, 1);
		slides.splice(target, 0, slide);
		draft.slides = slides.map((item, index) => ({ ...item, sortOrder: index + 1 }));
		previewSlideIndex = target;
	}

	function removeSlide(index: number) {
		if (!draft || !isDraftEditable) return;
		draft.slides = draft.slides
			.filter((_, slideIndex) => slideIndex !== index)
			.map((slide, index) => ({ ...slide, sortOrder: index + 1 }));
		previewSlideIndex = Math.min(previewSlideIndex, Math.max(draft.slides.length - 1, 0));
	}

	function slidePayload(): CampaignSlideDraft[] {
		return (draft?.slides ?? []).map((slide, sortOrder) => ({
			id: slide.id,
			kind: slide.kind,
			layoutType: slide.kind,
			semanticRole: slide.semanticRole ?? 'feature',
			sortOrder: sortOrder + 1,
			title: { en: slide.titleEn ?? '', hu: slide.titleHu ?? '' },
			titleEn: slide.titleEn ?? '',
			titleHu: slide.titleHu ?? '',
			body: { en: slide.bodyEn ?? '', hu: slide.bodyHu ?? '' },
			bodyEn: slide.bodyEn ?? '',
			bodyHu: slide.bodyHu ?? '',
			altText: { en: slide.altEn ?? '', hu: slide.altHu ?? '' },
			altEn: slide.altEn ?? '',
			altHu: slide.altHu ?? '',
			actionLabel: { en: slide.actionLabelEn ?? '', hu: slide.actionLabelHu ?? '' },
			actionLabelEn: slide.actionLabelEn ?? '',
			actionLabelHu: slide.actionLabelHu ?? '',
			actionDestination: slide.actionUrl ?? '',
			actionUrl: slide.actionUrl ?? '',
			desktopCropAssetId: slide.desktopAssetId ?? null,
			desktopAssetId: slide.desktopAssetId ?? null,
			mobileCropAssetId: slide.mobileAssetId ?? null,
			mobileAssetId: slide.mobileAssetId ?? null,
			desktopSourceAssetId: slide.desktopSourceAssetId ?? null,
			mobileSourceAssetId: slide.mobileSourceAssetId ?? null,
			setupControls: slide.setupControls ?? [],
		}));
	}

	async function saveDraft() {
		if (!draft || !isDraftEditable) return;
		saving = true;
		try {
			const campaign = await updateAdminCampaign(draft.id, {
				name: draft.name.trim() || null,
				type: draft.type,
				releaseVersion: draft.releaseVersion.trim() || null,
				slides: slidePayload(),
			});
			draft = draftFromCampaign({ ...campaign, validationErrors: campaign.validationErrors ?? draft.validationErrors });
			campaigns = campaigns.map((item) => (item.id === campaign.id ? { ...item, ...campaign } : item));
			showSuccess($t('admin.campaigns.messages.saved'));
		} catch (error) {
			showError(error, $t('admin.campaigns.errors.save'));
		} finally {
			saving = false;
		}
	}

	async function createCampaign() {
		actionLoading = true;
		try {
			const campaign = await createAdminCampaign({
				type: createType,
				name: createName.trim() || null,
				releaseVersion: createReleaseVersion.trim() || null,
			});
			createName = '';
			createReleaseVersion = '';
			showSuccess($t('admin.campaigns.messages.created'));
			await loadCampaigns(campaign.id);
		} catch (error) {
			showError(error, $t('admin.campaigns.errors.create'));
		} finally {
			actionLoading = false;
		}
	}

	async function seedFirstRun() {
		actionLoading = true;
		try {
			const result = await seedFirstRunCampaign();
			showSuccess(result.created ? $t('admin.campaigns.messages.seeded') : $t('admin.campaigns.messages.seedExists'));
			await loadCampaigns(result.campaign.id);
		} catch (error) {
			showError(error, $t('admin.campaigns.errors.seed'));
		} finally {
			actionLoading = false;
		}
	}

	async function publishCampaign() {
		if (!draft || !isDraftEditable) return;
		actionLoading = true;
		try {
			const campaign = await publishAdminCampaign(draft.id);
			draft = draftFromCampaign(campaign);
			campaigns = campaigns.map((item) => (item.id === campaign.id ? { ...item, ...campaign } : item));
			showSuccess($t('admin.campaigns.messages.published'));
		} catch (error) {
			showError(error, $t('admin.campaigns.errors.publish'));
		} finally {
			actionLoading = false;
		}
	}

	async function archiveCampaign(label: string) {
		if (!draft) return;
		const confirmed = window.confirm(label);
		if (!confirmed) return;
		actionLoading = true;
		try {
			const campaign = await archiveAdminCampaign(draft.id);
			draft = draftFromCampaign(campaign);
			campaigns = campaigns.map((item) => (item.id === campaign.id ? { ...item, ...campaign } : item));
			showSuccess($t('admin.campaigns.messages.archived'));
		} catch (error) {
			showError(error, $t('admin.campaigns.errors.archive'));
		} finally {
			actionLoading = false;
		}
	}

	async function deleteOrArchiveCampaign(label: string) {
		if (!draft) return;
		if (draft.status !== 'draft') {
			await archiveCampaign(label);
			return;
		}
		const confirmed = window.confirm(label);
		if (!confirmed) return;
		actionLoading = true;
		try {
			await deleteAdminCampaignDraft(draft.id);
			const deletedId = draft.id;
			draft = null;
			selectedCampaignId = null;
			showSuccess($t('admin.campaigns.messages.deleted'));
			await loadCampaigns(campaigns.find((item) => item.id !== deletedId)?.id ?? null);
		} catch (error) {
			showError(error, $t('admin.campaigns.errors.delete'));
		} finally {
			actionLoading = false;
		}
	}

	async function duplicateCampaign() {
		if (!draft) return;
		actionLoading = true;
		try {
			const campaign = await duplicateAdminCampaign(draft.id);
			showSuccess($t('admin.campaigns.messages.duplicated'));
			await loadCampaigns(campaign.id);
		} catch (error) {
			showError(error, $t('admin.campaigns.errors.duplicate'));
		} finally {
			actionLoading = false;
		}
	}

	async function handleAssetFile(event: Event, slideLocalId: string, variant: CampaignAssetVariant) {
		if (!isDraftEditable) return;
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		assetLoading = `${slideLocalId}:${variant}`;
		try {
			const source = await uploadCampaignAssetSource({ image: file });
			cropJob = {
				slideLocalId,
				variant,
				sourceAssetId: source.id,
				imageSrc: URL.createObjectURL(file),
			};
		} catch (error) {
			showError(error, $t('admin.campaigns.errors.assetUpload'));
		} finally {
			assetLoading = null;
		}
	}

	function attachCrop(slideLocalId: string, variant: CampaignAssetVariant, sourceAssetId: string, cropAssetId: string) {
		if (!draft || !isDraftEditable) return;
		draft.slides = draft.slides.map((slide) => {
			if (slide.localId !== slideLocalId) return slide;
			return {
				...slide,
				[variant === 'desktop' ? 'desktopAssetId' : 'mobileAssetId']: cropAssetId,
				[variant === 'desktop' ? 'desktopSourceAssetId' : 'mobileSourceAssetId']: sourceAssetId,
			};
		});
	}

	async function saveCrop(payload: { file: File; width: number; height: number; crop: CampaignAssetCropGeometry }) {
		if (!cropJob) return;
		const activeCrop = cropJob;
		const crop = await saveCampaignAssetCrop({
			sourceAssetId: activeCrop.sourceAssetId,
			variant: activeCrop.variant,
			image: payload.file,
			width: payload.width,
			height: payload.height,
			crop: payload.crop,
		});
		attachCrop(activeCrop.slideLocalId, activeCrop.variant, activeCrop.sourceAssetId, crop.id);
		URL.revokeObjectURL(activeCrop.imageSrc);
		cropJob = null;
	}

	function cancelCrop() {
		if (cropJob) URL.revokeObjectURL(cropJob.imageSrc);
		cropJob = null;
	}

	onMount(() => {
		void loadCampaigns();
	});
</script>

<section class="space-y-lg" aria-labelledby="admin-campaigns-heading">
	<div class="flex flex-wrap items-start justify-between gap-lg">
		<div>
			<h2 id="admin-campaigns-heading" class="text-lg font-semibold text-text-primary">
				{$t('admin.campaigns.title')}
			</h2>
			<p class="mt-1 max-w-3xl text-sm text-text-secondary">{$t('admin.campaigns.description')}</p>
		</div>
		<button type="button" class="btn-secondary cursor-pointer" disabled={actionLoading} onclick={seedFirstRun}>
			{$t('admin.campaigns.seedFirstRun')}
		</button>
	</div>

	{#if errorMessage}
		<p class="rounded-md border border-danger/30 bg-danger/10 px-md py-sm text-sm text-danger" role="alert">
			{errorMessage}
		</p>
	{/if}
	{#if successMessage}
		<p class="rounded-md border border-success/30 bg-success/10 px-md py-sm text-sm text-success" role="status">
			{successMessage}
		</p>
	{/if}

	<div class="campaign-workbench">
		<aside class="campaign-rail" aria-label={$t('admin.campaigns.listLabel')}>
			<form class="campaign-create-panel" onsubmit={(event) => { event.preventDefault(); void createCampaign(); }}>
				<div class="space-y-xs">
					<label class="block text-xs font-medium uppercase text-text-muted" for="campaign-create-name">
						{$t('admin.campaigns.createName')}
					</label>
					<input
						id="campaign-create-name"
						class="input-field w-full"
						bind:value={createName}
						placeholder={$t('admin.campaigns.createNamePlaceholder')}
					/>
				</div>
				<div class="grid grid-cols-2 gap-md">
					<label class="space-y-xs text-xs font-medium uppercase text-text-muted" for="campaign-create-type">
						{$t('admin.campaigns.type')}
						<select id="campaign-create-type" class="input-field w-full normal-case" bind:value={createType}>
							<option value="first_run_onboarding">{$t('admin.campaigns.type.firstRun')}</option>
							<option value="release_update">{$t('admin.campaigns.type.release')}</option>
						</select>
					</label>
					<label class="space-y-xs text-xs font-medium uppercase text-text-muted" for="campaign-create-version">
						{$t('admin.campaigns.releaseVersion')}
						<input id="campaign-create-version" class="input-field w-full normal-case" bind:value={createReleaseVersion} placeholder="1.0.0" />
					</label>
				</div>
				<button type="submit" class="btn-primary w-full cursor-pointer" disabled={actionLoading}>
					{$t('admin.campaigns.create')}
				</button>
			</form>

			<div class="campaign-list-scroll">
				{#if loading}
					<p class="p-md text-sm text-text-muted">{$t('admin.campaigns.loading')}</p>
				{:else if campaigns.length === 0}
					<p class="p-md text-sm text-text-muted">{$t('admin.campaigns.empty')}</p>
				{:else}
					{#each campaigns as campaign}
						<button
							type="button"
							class="campaign-row"
							class:campaign-row-active={selectedCampaignId === campaign.id}
							aria-pressed={selectedCampaignId === campaign.id}
							onclick={() => selectCampaign(campaign.id)}
						>
							<span class="flex items-center justify-between gap-sm">
								<span class="truncate font-medium text-text-primary">{fallbackCampaignName(campaign)}</span>
								<span class="rounded bg-surface-overlay px-xs py-0.5 text-[11px] uppercase text-text-muted">
									{statusLabel(campaign.status)}
								</span>
							</span>
							<span class="mt-1 grid grid-cols-2 gap-x-sm gap-y-1 text-left text-xs text-text-muted">
								<span>{campaign.type}</span>
								<span>{$t('admin.campaigns.versionShort', { version: campaign.version ?? 1 })}</span>
								<span>{$t('admin.campaigns.slideCount', { count: campaign.slideCount ?? campaign.slides?.length ?? 0 })}</span>
								<span>{formatDate(campaign.updatedAt ?? campaign.createdAt)}</span>
							</span>
						</button>
					{/each}
				{/if}
			</div>
		</aside>

		<main class="campaign-editor" aria-label={$t('admin.campaigns.editorLabel')}>
			{#if detailLoading}
				<p class="p-md text-sm text-text-muted">{$t('admin.campaigns.loadingDetail')}</p>
			{:else if draft}
				<div class="campaign-editor-body">
					<div class="campaign-editor-hero">
						<div class="min-w-0">
							<p class="text-xs font-semibold uppercase text-accent">
								{statusLabel(draft.status)} · {$t('admin.campaigns.versionShort', { version: draft.version ?? 1 })}
							</p>
							<h3 class="truncate text-lg font-semibold text-text-primary">
								{draft.name || $t('campaignModal.untitled')}
							</h3>
							<p class="mt-1 text-sm text-text-muted">
								{draft.type === 'first_run_onboarding' ? $t('admin.campaigns.type.firstRun') : $t('admin.campaigns.type.release')}
								{#if draft.releaseVersion}
									· {draft.releaseVersion}
								{/if}
							</p>
						</div>
						<div class="campaign-editor-stats">
							<span>{$t('admin.campaigns.slideCount', { count: draft.slides.length })}</span>
							<span>{$t('admin.campaigns.analyticsAutoShown', { count: draft.analyticsSummary?.autoShown ?? 0 })}</span>
							<span>{$t('admin.campaigns.analyticsCompleted', { count: draft.analyticsSummary?.completed ?? 0 })}</span>
						</div>
					</div>

					<div class="campaign-field-grid">
						<label class="space-y-xs text-sm font-medium text-text-primary">
							{$t('admin.campaigns.name')}
							<input class="input-field w-full" bind:value={draft.name} disabled={!isDraftEditable} />
						</label>
						<label class="space-y-xs text-sm font-medium text-text-primary">
							{$t('admin.campaigns.type')}
							<select class="input-field w-full" bind:value={draft.type} disabled={!isDraftEditable}>
								<option value="first_run_onboarding">{$t('admin.campaigns.type.firstRun')}</option>
								<option value="release_update">{$t('admin.campaigns.type.release')}</option>
							</select>
						</label>
						<label class="space-y-xs text-sm font-medium text-text-primary">
							{$t('admin.campaigns.releaseVersion')}
							<input class="input-field w-full" bind:value={draft.releaseVersion} placeholder="1.0.0" disabled={!isDraftEditable} />
						</label>
					</div>

					<div class="campaign-section-heading">
						<h3 class="text-base font-semibold text-text-primary">{$t('admin.campaigns.slides')}</h3>
						<div class="flex flex-wrap gap-sm">
							<button type="button" class="btn-secondary cursor-pointer" disabled={!isDraftEditable} onclick={() => addSlide('setup')}>
								{$t('admin.campaigns.addSetupSlide')}
							</button>
							<button type="button" class="btn-secondary cursor-pointer" disabled={!isDraftEditable} onclick={() => addSlide('standard')}>
								{$t('admin.campaigns.addStandardSlide')}
							</button>
						</div>
					</div>

					{#if draft.slides.length === 0}
						<p class="rounded-md border border-border bg-surface-overlay p-md text-sm text-text-muted">
							{$t('admin.campaigns.noSlides')}
						</p>
					{:else}
						<div class="slide-stack">
							{#each draft.slides as slide, index (slide.localId)}
								<section class="slide-editor" aria-label={$t('admin.campaigns.slideEditorLabel', { number: index + 1 })}>
									<div class="flex flex-wrap items-center justify-between gap-md border-b border-border bg-surface-overlay/35 px-lg py-md">
										<div>
											<p class="text-xs font-semibold uppercase text-text-muted">
												{$t('admin.campaigns.slideNumber', { number: index + 1 })} · {slideKindLabel(slide.kind)}
											</p>
											<h4 class="text-sm font-semibold text-text-primary">{slideTitle(slide)}</h4>
										</div>
										<div class="flex flex-wrap gap-xs">
											<button
												type="button"
												class="btn-secondary cursor-pointer"
												disabled={!isDraftEditable || index === 0}
												aria-label={$t('admin.campaigns.moveUpA11y', { title: slideTitle(slide) })}
												onclick={() => moveSlide(index, -1)}
											>
												↑
											</button>
											<button
												type="button"
												class="btn-secondary cursor-pointer"
												disabled={!isDraftEditable || index === draft.slides.length - 1}
												aria-label={$t('admin.campaigns.moveDownA11y', { title: slideTitle(slide) })}
												onclick={() => moveSlide(index, 1)}
											>
												↓
											</button>
											<button type="button" class="btn-secondary cursor-pointer" disabled={!isDraftEditable} onclick={() => removeSlide(index)}>
												{$t('common.delete')}
											</button>
										</div>
									</div>

									<div class="campaign-slide-content-grid">
										<label class="space-y-xs text-sm font-medium text-text-primary">
											{$t('admin.campaigns.slideKind')}
											<select class="input-field w-full" bind:value={slide.kind} disabled={!isDraftEditable}>
												<option value="setup">{$t('admin.campaigns.slideKind.setup')}</option>
												<option value="standard">{$t('admin.campaigns.slideKind.standard')}</option>
											</select>
										</label>
										<label class="space-y-xs text-sm font-medium text-text-primary">
											{$t('admin.campaigns.actionUrl')}
											<input class="input-field w-full" bind:value={slide.actionUrl} placeholder="/chat" disabled={!isDraftEditable} />
										</label>
										<label class="space-y-xs text-sm font-medium text-text-primary">
											{$t('admin.campaigns.titleEn')}
											<input class="input-field w-full" bind:value={slide.titleEn} disabled={!isDraftEditable} />
										</label>
										<label class="space-y-xs text-sm font-medium text-text-primary">
											{$t('admin.campaigns.titleHu')}
											<input class="input-field w-full" bind:value={slide.titleHu} disabled={!isDraftEditable} />
										</label>
										<label class="space-y-xs text-sm font-medium text-text-primary lg:col-span-2">
											{$t('admin.campaigns.bodyEn')}
											<textarea class="input-field min-h-24 w-full" bind:value={slide.bodyEn} disabled={!isDraftEditable}></textarea>
										</label>
										<label class="space-y-xs text-sm font-medium text-text-primary lg:col-span-2">
											{$t('admin.campaigns.bodyHu')}
											<textarea class="input-field min-h-24 w-full" bind:value={slide.bodyHu} disabled={!isDraftEditable}></textarea>
										</label>
										<label class="space-y-xs text-sm font-medium text-text-primary">
											{$t('admin.campaigns.altEn')}
											<input class="input-field w-full" bind:value={slide.altEn} disabled={!isDraftEditable} />
										</label>
										<label class="space-y-xs text-sm font-medium text-text-primary">
											{$t('admin.campaigns.altHu')}
											<input class="input-field w-full" bind:value={slide.altHu} disabled={!isDraftEditable} />
										</label>
										<label class="space-y-xs text-sm font-medium text-text-primary">
											{$t('admin.campaigns.actionLabelEn')}
											<input class="input-field w-full" bind:value={slide.actionLabelEn} disabled={!isDraftEditable} />
										</label>
										<label class="space-y-xs text-sm font-medium text-text-primary">
											{$t('admin.campaigns.actionLabelHu')}
											<input class="input-field w-full" bind:value={slide.actionLabelHu} disabled={!isDraftEditable} />
										</label>
									</div>

									<div class="campaign-asset-grid">
										<div class="space-y-sm">
											<p class="text-sm font-semibold text-text-primary">{$t('admin.campaigns.desktopAsset')}</p>
											<p class="text-xs text-text-muted">
												{slide.desktopAssetId ? $t('admin.campaigns.assetAttached', { id: slide.desktopAssetId }) : $t('admin.campaigns.assetMissing')}
											</p>
											<label class="btn-secondary inline-flex cursor-pointer" class:opacity-50={!isDraftEditable}>
												{$t('admin.campaigns.uploadDesktop')}
												<input class="sr-only" type="file" accept="image/*" disabled={!isDraftEditable} onchange={(event) => handleAssetFile(event, slide.localId, 'desktop')} />
											</label>
											{#if assetLoading === `${slide.localId}:desktop`}
												<p class="text-xs text-text-muted">{$t('admin.campaigns.uploadingAsset')}</p>
											{/if}
										</div>
										<div class="space-y-sm">
											<p class="text-sm font-semibold text-text-primary">{$t('admin.campaigns.mobileAsset')}</p>
											<p class="text-xs text-text-muted">
												{slide.mobileAssetId ? $t('admin.campaigns.assetAttached', { id: slide.mobileAssetId }) : $t('admin.campaigns.assetMissing')}
											</p>
											<label class="btn-secondary inline-flex cursor-pointer" class:opacity-50={!isDraftEditable}>
												{$t('admin.campaigns.uploadMobile')}
												<input class="sr-only" type="file" accept="image/*" disabled={!isDraftEditable} onchange={(event) => handleAssetFile(event, slide.localId, 'mobile')} />
											</label>
											{#if assetLoading === `${slide.localId}:mobile`}
												<p class="text-xs text-text-muted">{$t('admin.campaigns.uploadingAsset')}</p>
											{/if}
										</div>
									</div>
								</section>
							{/each}
						</div>
					{/if}
				</div>

				<div class="sticky bottom-0 z-10 border-t border-border bg-surface-page/95 p-lg backdrop-blur">
					<div class="flex flex-wrap items-start justify-between gap-lg">
						<div>
							<p class="text-sm font-semibold text-text-primary">
								{$t('admin.campaigns.publishChecklist')} · {statusLabel(draft.status)}
							</p>
							{#if validationErrors.length > 0}
								<ul class="mt-1 list-disc space-y-1 pl-md text-xs text-danger">
									{#each validationErrors as issue}
										<li>{issue.message}</li>
									{/each}
								</ul>
							{:else}
								<p class="mt-1 text-xs text-text-muted">{$t('admin.campaigns.noValidationErrors')}</p>
							{/if}
						</div>
						<div class="flex flex-wrap gap-sm">
							<button type="button" class="btn-secondary cursor-pointer" disabled={!canSave} onclick={saveDraft}>
								{saving ? $t('common.saving') : $t('admin.campaigns.saveDraft')}
							</button>
							<button type="button" class="btn-secondary cursor-pointer" disabled={!canDuplicate} onclick={duplicateCampaign}>
								{$t('admin.campaigns.duplicate')}
							</button>
							<button
								type="button"
								class="btn-secondary cursor-pointer"
								disabled={draft.status === 'draft' ? !canPublish : !canArchive}
								onclick={() => deleteOrArchiveCampaign(draft?.status === 'draft' ? $t('admin.campaigns.deleteDraftConfirm') : $t('admin.campaigns.archiveConfirm'))}
							>
								{draft.status === 'draft' ? $t('admin.campaigns.deleteDraft') : $t('admin.campaigns.archive')}
							</button>
							<button type="button" class="btn-primary cursor-pointer" disabled={!canPublish} onclick={publishCampaign}>
								{$t('admin.campaigns.publish')}
							</button>
						</div>
					</div>
				</div>
			{:else}
				<p class="p-md text-sm text-text-muted">{$t('admin.campaigns.selectCampaign')}</p>
			{/if}
		</main>

		<aside class="campaign-preview" aria-label={$t('admin.campaigns.previewLabel')}>
			<div class="flex items-center justify-between gap-sm border-b border-border p-md">
				<div>
					<p class="text-sm font-semibold text-text-primary">{$t('admin.campaigns.preview')}</p>
					<p class="text-xs text-text-muted">{$t('admin.campaigns.previewNote')}</p>
				</div>
				<select class="input-field max-w-24" bind:value={previewLocale} aria-label={$t('admin.campaigns.previewLanguage')}>
					<option value="en">EN</option>
					<option value="hu">HU</option>
				</select>
			</div>
			<div class="space-y-lg p-lg">
				<CampaignModal
					campaign={previewCampaign}
					locale={previewLocale}
					preview={true}
					inline={true}
					slideIndex={previewSlideIndex}
					onSlideChange={(index) => (previewSlideIndex = index)}
				/>

				<section class="border-t border-border pt-lg">
					<h3 class="text-sm font-semibold text-text-primary">{$t('admin.campaigns.history')}</h3>
					<dl class="mt-sm grid grid-cols-2 gap-sm text-xs">
						<dt class="text-text-muted">{$t('admin.campaigns.createdAt')}</dt>
						<dd class="text-text-primary">{formatDate(draft?.createdAt)}</dd>
						<dt class="text-text-muted">{$t('admin.campaigns.updatedAt')}</dt>
						<dd class="text-text-primary">{formatDate(draft?.updatedAt)}</dd>
						<dt class="text-text-muted">{$t('admin.campaigns.publishedAt')}</dt>
						<dd class="text-text-primary">{formatDate(draft?.publishedAt)}</dd>
						<dt class="text-text-muted">{$t('admin.campaigns.analytics')}</dt>
						<dd class="text-text-primary">
							{draft?.analyticsSummary?.autoShown ?? 0} / {draft?.analyticsSummary?.completed ?? 0} / {draft?.analyticsSummary?.skipped ?? 0} / {draft?.analyticsSummary?.replayOpened ?? 0}
						</dd>
					</dl>
				</section>
			</div>
		</aside>
	</div>
</section>

{#if cropJob}
	<CampaignCropModal
		imageSrc={cropJob.imageSrc}
		variant={cropJob.variant}
		ratio={cropJob.variant === 'desktop' ? 16 / 10 : 9 / 16}
		title={$t('admin.campaigns.cropTitle')}
		onSave={saveCrop}
		onCancel={cancelCrop}
	/>
{/if}

<style>
	.campaign-workbench {
		display: grid;
		grid-template-columns: minmax(230px, 280px) minmax(520px, 1fr) minmax(320px, 380px);
		gap: var(--space-lg);
		align-items: start;
		max-width: 100%;
		min-width: 0;
		overflow-x: clip;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-overlay) 14%, transparent);
		padding: var(--space-md);
	}

	.campaign-rail,
	.campaign-editor,
	.campaign-preview {
		min-width: 0;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-page);
		box-shadow: 0 10px 28px rgba(0, 0, 0, 0.08);
	}

	.campaign-create-panel {
		display: grid;
		gap: var(--space-sm);
		border-bottom: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface-overlay) 36%, transparent);
		padding: var(--space-md);
	}

	.input-field {
		display: block;
		min-height: 2.5rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface-page);
		padding: 0.55rem 0.75rem;
		color: var(--text-primary);
		font-size: 0.875rem;
		line-height: 1.35;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			box-shadow 0.15s ease;
	}

	:global(.campaign-workbench .btn-primary),
	:global(.campaign-workbench .btn-secondary) {
		min-height: 2.5rem;
		padding: 0.55rem 0.9rem;
	}

	textarea.input-field {
		min-height: 7rem;
		resize: vertical;
	}

	select.input-field {
		padding-right: 2rem;
	}

	.input-field:focus {
		border-color: var(--border-focus);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent);
		outline: none;
	}

	.input-field:disabled {
		cursor: not-allowed;
		opacity: 0.72;
	}

	.campaign-list-scroll {
		max-height: 64vh;
		overflow-y: auto;
		padding: var(--space-xs);
	}

	.campaign-row {
		display: block;
		width: 100%;
		border: 0;
		border-radius: 6px;
		background: transparent;
		padding: var(--space-sm);
		text-align: left;
		cursor: pointer;
		transition:
			background 0.15s ease,
			box-shadow 0.15s ease,
			transform 0.15s ease;
	}

	.campaign-row:hover,
	.campaign-row-active {
		background: var(--surface-overlay);
	}

	.campaign-row:hover {
		transform: translateY(-1px);
	}

	.campaign-editor-body {
		display: grid;
		gap: var(--space-lg);
		padding: var(--space-md);
	}

	.campaign-editor-hero {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
		border: 1px solid var(--border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-overlay) 42%, transparent);
		padding: var(--space-md);
	}

	.campaign-editor-stats {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}

	.campaign-editor-stats span {
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface-page);
		padding: 0.3rem 0.65rem;
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 600;
	}

	.campaign-field-grid {
		display: grid;
		gap: var(--space-sm);
		border: 1px solid var(--border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-overlay) 22%, transparent);
		padding: var(--space-md);
	}

	.campaign-section-heading {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
		border-top: 1px solid var(--border);
		padding-top: var(--space-md);
	}

	.slide-editor {
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-page);
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.06);
	}

	.slide-stack {
		display: grid;
		gap: var(--space-lg);
	}

	.campaign-slide-content-grid {
		display: grid;
		gap: var(--space-md);
		padding: var(--space-md);
	}

	.campaign-asset-grid {
		display: grid;
		gap: var(--space-md);
		border-top: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface-overlay) 34%, transparent);
		padding: var(--space-md);
	}

	button:focus-visible,
	input:focus-visible,
	select:focus-visible,
	textarea:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	@media (min-width: 768px) {
		.campaign-field-grid {
			grid-template-columns: minmax(0, 1fr) 160px 140px;
		}

		.campaign-slide-content-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.campaign-asset-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (max-width: 1600px) {
		.campaign-workbench {
			grid-template-columns: minmax(0, 1fr) minmax(300px, 340px);
			gap: var(--space-lg);
			padding: var(--space-sm);
		}

		.campaign-rail {
			order: 3;
			grid-column: 1 / 2;
			max-height: none;
		}

		.campaign-editor {
			order: 1;
		}

		.campaign-preview {
			order: 2;
			position: sticky;
			top: var(--space-lg);
		}

		.campaign-list-scroll {
			max-height: none;
		}
	}

	@media (max-width: 960px) {
		.campaign-workbench {
			grid-template-columns: 1fr;
			padding: var(--space-sm);
		}

		.campaign-preview {
			position: static;
		}

		.campaign-rail {
			grid-column: auto;
		}

		.campaign-editor-body,
		.campaign-slide-content-grid,
		.campaign-asset-grid {
			padding: var(--space-md);
		}
	}
</style>
