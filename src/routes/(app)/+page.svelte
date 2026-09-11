<script lang="ts">
import { goto } from "$app/navigation";
import { fade, fly } from "svelte/transition";
import { reducedMotionAware } from "$lib/utils/motion";
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
import { currentConversationId, requestSearchModalOpen } from "$lib/stores/ui";
import {
	EMPTY_HOME_SUMMARY,
	type HomeSuggestion,
	type HomeSummary,
	fetchHomeSummary,
	recordHomeSuggestionEvent,
} from "$lib/client/api/home";
import HomeRecent from "$lib/components/home/HomeRecent.svelte";
import HomeSuggestionRail from "$lib/components/home/HomeSuggestionRail.svelte";
import HomeWeeklyBars from "$lib/components/home/HomeWeeklyBars.svelte";
import {
	dayKeyFor,
	pickGreeting,
	readGreetingMemory,
	type ResolvedGreetingMemory,
	resolveGreetingMemory,
	timeOfDayFor,
	writeGreetingMemory,
} from "$lib/client/home/greeting";
import {
	selectedModel,
	selectedReasoningDepth,
	setSelectedReasoningDepth,
	uiLanguage,
} from "$lib/stores/settings";
import { t } from "$lib/i18n";
import DegradedCapabilitiesBanner from "$lib/components/chat/DegradedCapabilitiesBanner.svelte";
import MessageInput from "$lib/components/chat/MessageInput.svelte";
import DropZoneOverlay from "$lib/components/chat/DropZoneOverlay.svelte";
import { fetchPublicPersonalityProfiles } from "$lib/client/api/admin";
import { isOsFileDropEvent } from "$lib/utils/file-drag";
import type { ModelId } from "$lib/model-types";
import type { ReasoningDepth } from "$lib/reasoning-depth-types";
import type { AtlasProfile } from "$lib/server/services/atlas/public-types";
import type { ConversationDetail } from "$lib/server/services/conversation-detail/types";
import { onDestroy, onMount, untrack } from "svelte";
import type { ConversationDraft } from "$lib/server/services/conversations";
import type {
	ArtifactSummary,
	PendingAttachment,
} from "$lib/server/services/knowledge/types";
import type { LinkedContextSource } from "$lib/server/services/linked-context-sources";

// prefers-reduced-motion: the CSS reset in app.css cannot reach this
// JS-driven transition (see motion.ts), so wrap it explicitly.
const statusFade = reducedMotionAware(fade);
const greetingFade = reducedMotionAware(fade);
// The home board's three strips under the composer arrive together once the
// summary lands, rather than popping in one at a time as each read returns.
const boardFly = reducedMotionAware(fly);

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
	pendingSkill?:
		| import("$lib/server/services/skills/types").PendingSkillSelection
		| null;
	modelId?: ModelId;
	reasoningDepth?: ReasoningDepth;
	forceWebSearch?: boolean;
	// Issue 7.2 — composer connection capability selection for this turn.
	enabledConnectionCapabilities?: string[];
	atlasMode?: boolean;
	atlasProfile?: AtlasProfile | null;
	atlasAction?: "create";
	clientAtlasTurnId?: string | null;
};

type MessageInputDraftPayload = {
	conversationId: string | null;
	draftText: string;
	selectedAttachmentIds: string[];
	selectedAttachments: PendingAttachment[];
	selectedLinkedSources: LinkedContextSource[];
	pendingSkill:
		| import("$lib/server/services/skills/types").PendingSkillSelection
		| null;
	atlasMode?: boolean;
	atlasProfile?: AtlasProfile | null;
	clientAtlasTurnId?: string | null;
};

let hasStarted = $state(false);
let creating = $state(false);
let error: string | null = $state(null);
let isFromChat = $state(false);
let animateIn = $state(false);
let pendingMessagePreview = $state("");
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
let summary = $state<HomeSummary>(EMPTY_HOME_SUMMARY);
let summaryLoaded = $state(false);
let nowSeconds = $state(Math.floor(Date.now() / 1000));

// The greeting. The pool, the weights and the rule live in
// $lib/client/home/greeting.ts; this end only feeds it what the home screen
// already knows and renders the two forms it hands back.
//
// Fixed at mount rather than following `nowSeconds`: the pick is keyed on the
// time-of-day SLOT, so a ticking clock would change nothing four hours out of
// four and would re-run the pick every fifteen seconds to prove it. A page
// left open across a slot boundary keeps the line it was opened with, which is
// the behaviour you want from a heading somebody may be reading.
let greetingClock = $state(new Date());
// Defaults to "not the first visit": the line claiming otherwise must wait for
// localStorage, which only exists after mount, and claiming it on the server
// would make the first paint wrong for every reload of the day.
let greetingMemory = $state<ResolvedGreetingMemory>({
	firstVisitToday: false,
	excludeKey: null,
	firstSlot: timeOfDayFor(new Date().getHours()),
});
// The write below must never run before the read in onMount, or it would stamp
// today's date into storage and every later load would read itself back as the
// first visit of the day.
let greetingMemoryRead = $state(false);

// The summary-fed groups (quiet/busy week, continuity, running job, connected
// accounts) are gated on `summaryLoaded`, so the first paint draws from the
// generic, time-of-day and weekday lines and the greeting may change once when
// the summary lands a few tens of milliseconds later. That is the honest
// order: those lines assert something about the user's week, and asserting it
// before the read returns would mean asserting it from EMPTY_HOME_SUMMARY.
const greeting = $derived(
	pickGreeting({
		name: greetingName,
		// The id, not the name: two people called Anna get different lines, and
		// a rename does not reshuffle yours.
		userKey: data.user?.id ?? "",
		now: greetingClock,
		language: $uiLanguage,
		summaryLoaded,
		week: {
			counts: summary.weekly.map((week) => week.count),
			total: summary.weeklyTotal,
		},
		running: summary.running ? { kind: summary.running.kind } : null,
		topTitle: summary.recent[0]?.title ?? null,
		connectedKinds: summary.connectedKinds,
		firstVisitToday: greetingMemory.firstVisitToday,
		excludeKey: greetingMemory.excludeKey,
		translate: $t,
	}),
);
const greetingPlain = $derived(greeting.plain);
const activeGreeting = $derived(greetingName ? greeting.named : greeting.plain);

// Remembers today's line so tomorrow's pick can avoid it. Runs in the browser
// only, and `writeGreetingMemory` swallows a storage that refuses to be
// written to.
$effect(() => {
	if (!greetingMemoryRead) return;
	writeGreetingMemory({
		day: dayKeyFor(greetingClock),
		firstSlot: greetingMemory.firstSlot,
		key: greeting.key,
	});
});

async function refreshHomeSummary() {
	try {
		summary = await fetchHomeSummary();
	} catch {
		// The board degrades to a greeting and a composer rather than to an
		// error: none of these strips is something the user asked for.
		summary = EMPTY_HOME_SUMMARY;
	} finally {
		summaryLoaded = true;
	}
}

let composeIntoComposer: ((text: string) => void) | null = null;

function handleComposeReady(compose: (text: string) => void) {
	composeIntoComposer = compose;
}

function handleSuggestionPick(suggestion: HomeSuggestion) {
	if (creating) return;
	// Fire and forget: the page has navigated by the time this resolves, and a
	// failed write only means a chip the user already used may come back. The
	// request is `keepalive` so the navigation cannot cancel it.
	void recordHomeSuggestionEvent(suggestion.key, "used").catch(() => undefined);
	// A chip is a message typed for you, so it goes in the box and presses the
	// composer's own Send. Building a payload here instead would drop whatever
	// the composer is holding — an attachment, a linked source, an Atlas
	// profile, the connection capabilities for this turn — and would send
	// straight past the "wait for the upload to finish" queue.
	if (composeIntoComposer) {
		composeIntoComposer(suggestion.text);
		return;
	}
	// The composer has not mounted yet (no chips are drawn before it does, so
	// this is a belt-and-braces path, not a normal one).
	void handleSend({
		message: suggestion.text,
		attachmentIds: [],
		attachments: [],
		conversationId: preparedConversationId,
		linkedSources: [],
		pendingSkill: null,
	});
}
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
	| {
			success: true;
			attachment: import("$lib/server/services/knowledge/types").PendingAttachment;
	  }
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

	// The browser's clock and the browser's memory of yesterday's line, neither
	// of which the server could have supplied.
	greetingClock = new Date();
	greetingMemory = resolveGreetingMemory(
		readGreetingMemory(),
		dayKeyFor(greetingClock),
		timeOfDayFor(greetingClock.getHours()),
	);
	greetingMemoryRead = true;

	void fetchPublicPersonalityProfiles()
		.then((p) => (personalityProfiles = p))
		.catch(() => {});

	void refreshHomeSummary();

	// The summary is cached 30 seconds server-side, so polling faster would
	// only re-read the cache. The clock ticks every 15 so the running line's
	// elapsed time does not sit still between polls.
	const summaryTimer = setInterval(() => {
		if (hasStarted) return;
		void refreshHomeSummary();
	}, 30_000);
	const clockTimer = setInterval(() => {
		nowSeconds = Math.floor(Date.now() / 1000);
	}, 15_000);
	return () => {
		clearInterval(summaryTimer);
		clearInterval(clockTimer);
	};
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
				atlasMode: false,
				atlasProfile: null,
				clientAtlasTurnId: null,
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
			enabledConnectionCapabilities: payload.enabledConnectionCapabilities,
			atlasMode: payload.atlasMode === true,
			atlasProfile: payload.atlasProfile ?? null,
			atlasAction: payload.atlasAction ?? "create",
			clientAtlasTurnId: payload.clientAtlasTurnId ?? null,
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
		atlasMode: payload.atlasMode === true,
		atlasProfile: payload.atlasProfile ?? null,
		clientAtlasTurnId: payload.clientAtlasTurnId ?? null,
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
		atlasMode: payload.atlasMode === true,
		atlasProfile: payload.atlasProfile ?? null,
		clientAtlasTurnId: payload.clientAtlasTurnId ?? null,
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
			<div class="home-column mx-auto flex w-full max-w-[780px] flex-col px-1">
				{#if !hasStarted}
					<!-- The greeting carries the record on its own line: the twelve
					     weekly bars and the week's count, right-aligned and sitting on
					     the greeting's baseline. -->
					<div class="home-band" in:greetingFade={{ duration: isFromChat ? 400 : 0, delay: isFromChat ? 100 : 0 }}>
						<h1 class="home-greeting" data-testid="home-greeting">
							<span class="home-greeting-full">{activeGreeting}</span>
							<span class="home-greeting-plain">{greetingPlain}</span>
						</h1>
						<HomeWeeklyBars weeks={summary.weekly} total={summary.weeklyTotal} />
					</div>
				{/if}

				{#if creating && pendingMessagePreview}
					<div class="pending-message-preview" transition:statusFade={{ duration: 150 }}>
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
					<div class="creating-indicator" transition:statusFade={{ duration: 150 }}>
						<div class="spinner"></div>
						<span class="text-sm text-text-muted">{$t('openingChat')}</span>
					</div>
				{/if}

				<MessageInput
					onSend={handleSend}
					onDraftChange={handleDraftChange}
					disabled={creating}
					maxLength={data.maxMessageLength}
					showSlashHintProp={false}
					composerCommandRegistryEnabled={data.composerCommandRegistryEnabled}
					conversationId={preparedConversationId}
					contextStatus={null}
					attachedArtifacts={[]}
					contextDebug={null}
					draftText={conversationDraft?.draftText ?? ''}
					draftAttachments={conversationDraft?.selectedAttachments ?? []}
					draftLinkedSources={conversationDraft?.selectedLinkedSources ?? []}
					draftAtlasMode={conversationDraft?.atlasMode === true}
					draftAtlasProfile={conversationDraft?.atlasProfile ?? null}
					draftClientAtlasTurnId={conversationDraft?.clientAtlasTurnId ?? null}
					draftVersion={conversationDraft?.updatedAt ?? 0}
					attachmentsEnabled={true}
					ensureConversation={ensurePreparedConversation}
					onUploadReady={handleUploadReady}
					onComposeReady={handleComposeReady}
					{personalityProfiles}
					{selectedPersonalityId}
					onPersonalityChange={(id) => selectedPersonalityId = id}
					reasoningDepth={$selectedReasoningDepth}
					onReasoningDepthChange={setSelectedReasoningDepth}
					atlasAvailability={data.atlasAvailability ?? null}
					onUploadFiles={handleUploadFiles}
				/>

				{#if !hasStarted && summaryLoaded}
					<!-- The owner's one change to the board: the suggestion chips sit
					     on their OWN row directly under the composer box rather than
					     inside the composer's footer, which keeps the composer's own
					     controls to themselves. Then Recent, then the tool-health
					     strip as the last and quietest line. -->
					<div
						class="home-board"
						in:boardFly={{ y: 6, duration: 220, delay: 40 }}
						data-testid="home-board"
					>
						<HomeSuggestionRail
							suggestions={summary.suggestions}
							disabled={creating}
							onPick={handleSuggestionPick}
						/>

						<HomeRecent
							recent={summary.recent}
							running={summary.running}
							{nowSeconds}
							onAllConversations={requestSearchModalOpen}
						/>

						<div class="home-strip">
							<DegradedCapabilitiesBanner
								isAdmin={data.user?.role === 'admin'}
								variant="strip"
							/>
						</div>
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
	/* HomeV4A "Compact": three groups instead of four — the greeting with the
	   record on its line, the composer, then everything else underneath as
	   reference. The composer is the second thing on the page and the first
	   thing you can act on, which is the correct order for a chat app. */
	.home-band {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 26px;
		margin-bottom: 20px;
		padding: 0 2px;
	}

	/* The air above the greeting. HomeV4A gives the greeting room to land in
	   rather than starting it against the top of the stage; the layer below is
	   vertically centred, so the air is carried as the band's own padding and
	   exists only in the greeting state — once the composer hands off to a
	   conversation the band is gone and takes its padding with it.

	   Behind a height query because air is the FIRST thing that should give
	   way: on a 460px-tall window the board already scrolls to keep the
	   composer whole, and a decorative 40px must not be the reason it has to.
	   (Phone sizing lives with the rest of the phone rules below.) */
	@media (min-height: 560px) {
		.home-band {
			padding-top: 40px;
		}
	}

	.home-greeting {
		min-width: 0;
		margin: 0;
		font-family: var(--font-serif, Georgia, 'Times New Roman', serif);
		font-size: 1.75rem;
		font-weight: 500;
		line-height: 1.2;
		letter-spacing: -0.02em;
		text-wrap: balance;
		color: color-mix(in srgb, var(--text-primary) 60%, var(--accent) 40%);
	}

	.home-greeting-plain {
		display: none;
	}

	/* The column used to be a greeting and a box, which always fitted. Now that
	   Recent and the strip hang off the bottom of a vertically centred layer, a
	   short window (or a phone in landscape) can run it past the stage.

	   The scroll goes on the BOARD, not on the column. A scroll container on the
	   column would clip everything the composer opens upwards out of its own
	   footer — the "+" menu, the accounts popover, the model picker are all
	   `bottom: 100%` boxes taller than the greeting above them, and a scrolling
	   ancestor cuts them off mid-air. The board hangs BELOW the composer and
	   opens nothing, so it can scroll without taking the composer's overlays
	   with it. The layer takes the stage's height as its ceiling so there is a
	   height for the board to be short of in the first place; `max-height: 100%`
	   on the column alone resolved against an auto-height parent and did
	   nothing at all. */
	.composer-layer {
		display: flex;
		flex-direction: column;
		max-height: 100%;
	}

	.home-column {
		min-height: 0;
	}

	/* Only the board gives way. The greeting and the composer keep their height
	   whatever the window does — a composer squeezed to half a textarea would be
	   a worse answer to a short window than a Recent list that scrolls. */
	.home-column > :global(*) {
		flex-shrink: 0;
	}

	.home-board {
		min-width: 0;
		min-height: 0;
		flex-shrink: 1;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
	}

	/* The status blocks between the greeting and the composer used to be spaced
	   by the column's own gap; the board's spacing is per-group, so they carry
	   their own. */
	.home-column > :global(.pending-message-preview),
	.home-column > :global(.creating-indicator),
	.home-column > :global([role='alert']) {
		margin-bottom: 1rem;
	}

	/* The tool-health strip sits 12px under Recent. It is last because it is
	   about the system rather than about you. */
	.home-strip {
		margin-top: 12px;
	}

	@media (max-width: 767px) {
		.home-band {
			gap: 14px;
			margin-bottom: 18px;
		}

		.home-greeting {
			font-size: 1.4rem;
		}

		/* "Admin User" pushes the greeting to a third line at 390px. */
		.home-greeting-full {
			display: none;
		}

		.home-greeting-plain {
			display: inline;
		}
	}

	/* 24px rather than 40 on a phone: 40 on a 390×844 screen is air bought with
	   the bottom of the composer, and the composer staying above the fold is
	   worth more than the gap. Asserted in home-compact.spec.ts. */
	@media (max-width: 767px) and (min-height: 560px) {
		.home-band {
			padding-top: 24px;
		}
	}

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
