<script lang="ts">
import { goto } from "$app/navigation";
import { fade, fly } from "svelte/transition";
import {
	cleanupPreparedConversation,
	consumePreviousConversationId,
	createConversationDraftRecord,
	createDraftPersistence,
	getLandingDraftConversationId,
	setConversationPersonalitySelection,
	setLandingDraftConversationId,
	storePendingConversationMessage,
} from "$lib/client/conversation-session";
import { fetchConversationDetail } from "$lib/client/api/conversations";
import { uploadKnowledgeAttachment } from "$lib/client/api/knowledge";
import {
	createNewConversation,
	upsertConversationLocal,
} from "$lib/stores/conversations";
import { currentConversationId } from "$lib/stores/ui";
import {
	selectedModel,
	selectedReasoningDepth,
	setSelectedReasoningDepth,
} from "$lib/stores/settings";
import { t } from "$lib/i18n";
import MessageInput from "$lib/components/chat/MessageInput.svelte";
import DropZoneOverlay from "$lib/components/chat/DropZoneOverlay.svelte";
import { fetchPublicPersonalityProfiles } from "$lib/client/api/admin";
import { isOsFileDropEvent } from "$lib/utils/file-drag";
import type { ConversationDetail, ModelId, ReasoningDepth } from "$lib/types";
import { onDestroy, onMount, untrack } from "svelte";
import type {
	ArtifactSummary,
	ConversationDraft,
	LinkedContextSource,
	PendingAttachment,
} from "$lib/types";

function canReuseLandingPreparedConversation(
	detail: Pick<
		ConversationDetail,
		"conversation" | "messages" | "generatedFiles"
	>,
): boolean {
	return (
		detail.conversation.title === "New Conversation" &&
		(detail.messages?.length ?? 0) === 0 &&
		(detail.generatedFiles?.length ?? 0) === 0
	);
}

async function navigateToConversationFromLanding(params: {
	conversationId: string;
	goto: (href: string) => Promise<void>;
	hardNavigate?: ((href: string) => void) | null;
	bootstrap?: boolean;
}): Promise<void> {
	const href = `/chat/${params.conversationId}${params.bootstrap ? "?view=bootstrap" : ""}`;

	// The landing-to-chat bootstrap path is vulnerable to stale SPA state after deploys
	// or restarts. Prefer a full document navigation when available so the browser cannot
	// remain visually stuck on the landing surface while the new chat is already running.
	if (params.hardNavigate) {
		params.hardNavigate(href);
		return;
	}

	await params.goto(href);
}
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

type MessageInputSendPayload = {
	message: string;
	attachmentIds: string[];
	attachments: ArtifactSummary[];
	conversationId: string | null;
	linkedSources?: LinkedContextSource[];
	pendingSkill?: import("$lib/types").PendingSkillSelection | null;
	modelId?: ModelId;
	reasoningDepth?: ReasoningDepth;
	forceWebSearch?: boolean;
};

type MessageInputDraftPayload = {
	conversationId: string | null;
	draftText: string;
	selectedAttachmentIds: string[];
	selectedAttachments: PendingAttachment[];
	selectedLinkedSources: LinkedContextSource[];
	pendingSkill: import("$lib/types").PendingSkillSelection | null;
};

let hasStarted = $state(false);
let creating = $state(false);
let error: string | null = $state(null);
let isFromChat = $state(false);
let animateIn = $state(false);
let pendingMessagePreview = $state("");
let greetingIndex = $state(0);
let preparedConversationId: string | null = $state(null);
let preparedConversationPromise: Promise<string> | null = null;
let preparedConversationValidationPromise: Promise<void> | null = null;
let conversationDraft: ConversationDraft | null = $state(null);
const draftPersistence = createDraftPersistence();

const greetingName = $derived(
	data.user?.displayName?.trim() ||
		data.user?.email?.split("@")[0]?.trim() ||
		"",
);
const greetingOptions = $derived([
	greetingName
		? $t("landingGreetingNamed", { name: greetingName })
		: $t("landingGreeting"),
	greetingName
		? $t("landingReadyNamed", { name: greetingName })
		: $t("landingReady"),
	greetingName
		? $t("landingWorkNamed", { name: greetingName })
		: $t("landingWork"),
	greetingName
		? $t("landingWhatsOnMindNamed", { name: greetingName })
		: $t("landingWhatsOnMind"),
	greetingName
		? $t("landingAskMeNamed", { name: greetingName })
		: $t("landingAskMe"),
	greetingName
		? $t("landingGettingStartedNamed", { name: greetingName })
		: $t("landingGettingStarted"),
	greetingName
		? $t("landingListeningNamed", { name: greetingName })
		: $t("landingListening"),
]);
const activeGreeting = $derived(
	greetingOptions[greetingIndex % greetingOptions.length],
);
let fileDragActive = $state(false);
let fileDragRejected = $state(false);
let personalityProfiles: Array<{
	id: string;
	name: string;
	description: string;
}> = $state([]);
let selectedPersonalityId: string | null = $state(
	untrack(() => data.userPersonality) ?? null,
);
let dragEnterCount = 0;
let uploadFilesFn: ((files: FileList | null) => Promise<void>) | null = null;

function handleUploadReady(
	uploadFn: (files: FileList | null) => Promise<void>,
) {
	uploadFilesFn = uploadFn;
}

type UploadFileResult =
	| { success: true; attachment: import("$lib/types").PendingAttachment }
	| { success: false; fileName: string; error: string };

async function uploadSingleFile(
	file: File,
	conversationId: string,
): Promise<UploadFileResult> {
	try {
		const result = await uploadKnowledgeAttachment(file, conversationId);
		if (result?.artifact) {
			return {
				success: true,
				attachment: {
					artifact: result.artifact,
					promptReady: Boolean(result.promptReady),
					promptArtifactId:
						typeof result.promptArtifactId === "string"
							? result.promptArtifactId
							: null,
					readinessError:
						typeof result.readinessError === "string" &&
						result.readinessError.trim()
							? result.readinessError
							: null,
				},
			};
		}
		return { success: false, fileName: file.name, error: "Upload failed" };
	} catch (err) {
		return {
			success: false,
			fileName: file.name,
			error: err instanceof Error ? err.message : "Upload failed",
		};
	}
}

function handleUploadFiles(payload: {
	files: File[];
	conversationId: string;
	done: (result: UploadFileResult) => void;
}) {
	for (const file of payload.files) {
		uploadSingleFile(file, payload.conversationId).then(payload.done);
	}
}

function handleDragEnter(event: DragEvent) {
	if (!isOsFileDropEvent(event)) return;
	event.preventDefault();
	dragEnterCount += 1;
	fileDragActive = true;
	fileDragRejected = false;
}

function handleDragOver(event: DragEvent) {
	if (!isOsFileDropEvent(event)) return;
	event.preventDefault();
	if (event.dataTransfer) {
		event.dataTransfer.dropEffect = "copy";
	}
}

function handleDragLeave(event: DragEvent) {
	if (!isOsFileDropEvent(event)) return;
	dragEnterCount -= 1;
	if (dragEnterCount <= 0) {
		dragEnterCount = 0;
		fileDragActive = false;
		fileDragRejected = false;
	}
}

function handleDrop(event: DragEvent) {
	dragEnterCount = 0;
	fileDragActive = false;
	fileDragRejected = false;
	if (!isOsFileDropEvent(event)) return;
	event.preventDefault();
	const files = event.dataTransfer?.files;
	if (!files || files.length === 0) return;
	void uploadFilesFn?.(files);
}

onMount(() => {
	const previousId = consumePreviousConversationId();
	if (previousId) {
		isFromChat = true;
		setTimeout(() => {
			animateIn = true;
		}, 50);
	} else {
		animateIn = true;
	}

	const storedConversationId = getLandingDraftConversationId();
	if (storedConversationId) {
		preparedConversationId = storedConversationId;
		preparedConversationValidationPromise = restorePreparedConversation(
			storedConversationId,
		).finally(() => {
			preparedConversationValidationPromise = null;
		});
	}

	// Static random greeting per page load (no rotation)
	greetingIndex = Math.floor(Math.random() * 7);

	void fetchPublicPersonalityProfiles()
		.then((p) => (personalityProfiles = p))
		.catch(() => {});
});

onDestroy(() => {
	void draftPersistence.flush();
});

async function ensurePreparedConversation(): Promise<string> {
	if (preparedConversationValidationPromise) {
		await preparedConversationValidationPromise;
	}
	if (preparedConversationId) {
		return preparedConversationId;
	}
	if (!preparedConversationPromise) {
		preparedConversationPromise = createNewConversation()
			.then((id) => {
				preparedConversationId = id;
				setLandingDraftConversationId(id);
				return id;
			})
			.finally(() => {
				preparedConversationPromise = null;
			});
	}
	return preparedConversationPromise;
}

async function handleSend(payload: MessageInputSendPayload) {
	if (creating) return;
	const text = payload.message;

	hasStarted = true;
	creating = true;
	error = null;
	pendingMessagePreview = text;

	try {
		const id = payload.conversationId ?? (await ensurePreparedConversation());
		currentConversationId.set(id);
		upsertConversationLocal(id, "New Conversation", Date.now() / 1000);
		setConversationPersonalitySelection(id, selectedPersonalityId);
		setLandingDraftConversationId(null);
		conversationDraft = null;
		draftPersistence.clear();
		void draftPersistence.persist(
			{
				conversationId: id,
				draftText: "",
				selectedAttachmentIds: [],
				selectedLinkedSources: [],
				pendingSkill: null,
			},
			true,
		);
		storePendingConversationMessage(id, {
			message: text,
			attachmentIds: payload.attachmentIds,
			attachments: payload.attachments,
			linkedSources: payload.linkedSources ?? [],
			pendingSkill: payload.pendingSkill ?? null,
			modelId: payload.modelId ?? $selectedModel,
			personalityProfileId: selectedPersonalityId,
			reasoningDepth: payload.reasoningDepth ?? $selectedReasoningDepth,
			forceWebSearch: payload.forceWebSearch === true,
		});
		await navigateToConversationFromLanding({
			conversationId: id,
			goto: (href) => goto(href),
			hardNavigate:
				typeof window !== "undefined"
					? (href) => window.location.assign(href)
					: null,
			bootstrap: true,
		});
	} catch {
		error = "Failed to create conversation. Please try again.";
		hasStarted = false;
		pendingMessagePreview = "";
	} finally {
		creating = false;
	}
}

async function restorePreparedConversation(conversationId: string) {
	try {
		const payload = await fetchConversationDetail(conversationId);
		if (!canReuseLandingPreparedConversation(payload)) {
			preparedConversationId = null;
			conversationDraft = null;
			setLandingDraftConversationId(null);
			return;
		}
		conversationDraft = payload.draft ?? null;
	} catch {
		preparedConversationId = null;
		conversationDraft = null;
		setLandingDraftConversationId(null);
	}
}

function handleDraftChange(payload: MessageInputDraftPayload) {
	const nextDraft = createConversationDraftRecord({
		conversationId: payload.conversationId,
		fallbackConversationId: preparedConversationId,
		draftText: payload.draftText,
		selectedAttachmentIds: payload.selectedAttachmentIds,
		selectedAttachments: payload.selectedAttachments,
		selectedLinkedSources: payload.selectedLinkedSources,
		pendingSkill: payload.pendingSkill,
	});
	const stalePreparedConversationId =
		payload.conversationId ?? preparedConversationId ?? null;

	if (!nextDraft) {
		conversationDraft = null;
		if (hasStarted || creating) {
			return;
		}
		preparedConversationId = null;
		setLandingDraftConversationId(null);
		if (stalePreparedConversationId) {
			cleanupPreparedConversation({
				conversationId: stalePreparedConversationId,
			});
		}
		return;
	}

	conversationDraft = nextDraft;
	if (nextDraft.conversationId !== "draft") {
		preparedConversationId = nextDraft.conversationId;
		setLandingDraftConversationId(nextDraft.conversationId);
	}
	void draftPersistence.persist({
		conversationId: nextDraft.conversationId,
		draftText: payload.draftText,
		selectedAttachmentIds: payload.selectedAttachmentIds,
		selectedLinkedSources: payload.selectedLinkedSources,
		pendingSkill: payload.pendingSkill,
	});
}
</script>

<svelte:head>
	<title>Alfy AI</title>
</svelte:head>

<div
	class="chat-page flex h-full min-w-0 flex-col bg-surface-page"
	role="region"
	aria-label="Landing page"
	ondragenter={handleDragEnter}
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
>
	<DropZoneOverlay active={fileDragActive} rejected={fileDragRejected} />
	<div class="chat-stage relative flex min-h-0 flex-1 overflow-hidden rounded-lg">
		<div
			class="composer-layer"
			class:composer-layer-animate={isFromChat && animateIn}
			class:composer-layer-no-animate={!isFromChat}
			class:composer-layer-handoff={hasStarted}
		>
			<div class="mx-auto flex w-full max-w-[780px] flex-col gap-4 px-1">
				{#if !hasStarted}
					<div class="intro-copy px-2 text-center" in:fade={{ duration: isFromChat ? 400 : 0, delay: isFromChat ? 100 : 0 }}>
						<h1
							class="text-balance text-[2rem] font-serif font-medium tracking-[-0.05em] md:text-[3rem]"
							style="color: color-mix(in srgb, var(--text-primary) 60%, var(--accent) 40%); font-weight: 500;"
						>
							{activeGreeting}
						</h1>
					</div>
				{/if}

				{#if creating && pendingMessagePreview}
					<div class="pending-message-preview" transition:fade={{ duration: 150 }}>
						<div class="pending-message-label">{$t('startingConversation')}</div>
						<p class="pending-message-body">{pendingMessagePreview}</p>
					</div>
				{/if}

				{#if error}
					<div class="w-full rounded-md border border-danger bg-surface-page p-md text-sm font-serif text-danger shadow-sm" role="alert">
						{error}
					</div>
				{/if}

				{#if creating}
					<div class="creating-indicator" transition:fade={{ duration: 150 }}>
						<div class="spinner"></div>
						<span class="text-sm text-text-muted">{$t('openingChat')}</span>
					</div>
				{/if}

				<MessageInput
					onSend={handleSend}
					onDraftChange={handleDraftChange}
					disabled={creating}
					maxLength={data.maxMessageLength}
					composerCommandRegistryEnabled={data.composerCommandRegistryEnabled}
					conversationId={preparedConversationId}
					contextStatus={null}
					attachedArtifacts={[]}
					contextDebug={null}
					draftText={conversationDraft?.draftText ?? ''}
					draftAttachments={conversationDraft?.selectedAttachments ?? []}
					draftLinkedSources={conversationDraft?.selectedLinkedSources ?? []}
					draftVersion={conversationDraft?.updatedAt ?? 0}
					attachmentsEnabled={true}
					ensureConversation={ensurePreparedConversation}
					onUploadReady={handleUploadReady}
					{personalityProfiles}
					{selectedPersonalityId}
					onPersonalityChange={(id) => selectedPersonalityId = id}
					reasoningDepth={$selectedReasoningDepth}
					onReasoningDepthChange={setSelectedReasoningDepth}
				onUploadFiles={handleUploadFiles}
				/>
			</div>
		</div>
	</div>
</div>

<style>
	.composer-layer {
		position: absolute;
		left: 0;
		right: 0;
		top: 100%;
		transform: translateY(0);
		opacity: 0;
		transition:
			top 420ms cubic-bezier(0.22, 1, 0.36, 1),
			transform 420ms cubic-bezier(0.22, 1, 0.36, 1),
			opacity 320ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	/* No animation - directly at center (for direct navigation to landing) */
	.composer-layer-no-animate {
		top: 50%;
		transform: translateY(-50%);
		opacity: 1;
		transition: none;
	}

	/* Animation class - animates from bottom (100%) to center (50%) */
	.composer-layer-animate {
		top: 50%;
		transform: translateY(-50%);
		opacity: 1;
	}

	.composer-layer-handoff {
		top: 100%;
		transform: translateY(calc(-100% - max(1.5rem, env(safe-area-inset-bottom))));
		opacity: 1;
		transition:
			top 320ms cubic-bezier(0.22, 1, 0.36, 1),
			transform 320ms cubic-bezier(0.22, 1, 0.36, 1),
			opacity 220ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	/* On mobile the header (52px) shifts the available area down, making top:50%
	   land 26px below the true screen center. Compensate by nudging up. */
	@media (max-width: 767px) {
		.composer-layer-no-animate,
		.composer-layer-animate {
			top: calc(50% - 26px);
		}
	}

	.creating-indicator {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-sm);
		padding: var(--space-md);
	}

	.pending-message-preview {
		align-self: flex-end;
		max-width: min(100%, 44rem);
		border: 1px solid color-mix(in srgb, var(--border-default) 55%, transparent 45%);
		background:
			linear-gradient(180deg, color-mix(in srgb, var(--surface-elevated) 92%, white 8%), var(--surface-elevated));
		border-radius: calc(var(--radius-lg) + 2px);
		padding: var(--space-md) var(--space-lg);
		box-shadow: var(--shadow-sm);
	}

	.pending-message-label {
		margin-bottom: var(--space-xs);
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.pending-message-body {
		margin: 0;
		font-size: 1rem;
		line-height: 1.55;
		color: var(--text-primary);
		word-break: break-word;
	}

	.spinner {
		width: 16px;
		height: 16px;
		border: 2px solid var(--border-default);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}
</style>
