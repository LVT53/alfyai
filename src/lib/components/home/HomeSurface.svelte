<script lang="ts">
/**
 * The landing surface — and, in project mode, the project page.
 *
 * Everything about the home screen that is not data loading lives here: the
 * greeting, the incognito arm, the composer and its draft/attachment plumbing,
 * the prepared conversation, and the board under the composer. It was moved
 * out of `src/routes/(app)/+page.svelte` verbatim (Workspaces Slice D) so the
 * project page could be the same surface in another mode rather than a fork
 * with its own send path, its own draft flow and its own incognito arm.
 *
 * The caller loads: the layout `data` fields below and the home summary. The
 * surface renders them and owns everything you can act on. `recent` and
 * `weekly` arrive as props rather than being read from a summary object
 * because the project page scopes them differently: it passes the project's
 * own chats and has no weekly bars at all.
 */
import { goto } from "$app/navigation";
import { Pencil, VenetianMask } from "@lucide/svelte";
import { fade, fly } from "svelte/transition";
import { reducedMotionAware } from "$lib/utils/motion";
import { INCOGNITO_GREETINGS } from "$lib/i18n/chat";
import { shouldShowIncognitoArm } from "$lib/client/home/landing-incognito";
import { makeGrammarFormatters } from "$lib/client/connections/status-grammar";
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
import {
	fetchConversationDetail,
	setConversationMemoryIncognito,
} from "$lib/client/api/conversations";
import {
	uploadKnowledgeAttachment,
	uploadRefusalFromError,
} from "$lib/client/api/knowledge";
import { extractionFromUploadResponse } from "$lib/client/extraction-poll";
import { isAttachmentReadinessReason } from "$lib/shared/attachment-readiness";
import {
	createNewConversation,
	updateConversationMemoryIncognitoLocal,
	upsertConversationLocal,
} from "$lib/stores/conversations";
import {
	currentConversationId,
	landingIncognitoArmed,
	landingIncognitoArmVisible,
	landingResetRequested,
	requestSearchModalOpen,
} from "$lib/stores/ui";
import { get } from "svelte/store";
import {
	dismissMemoryReviewNotice,
	type HomeRecentConversation,
	type HomeRunningJob,
	type HomeSuggestion,
	type HomeWeeklyBucket,
	recordHomeSuggestionEvent,
} from "$lib/client/api/home";
import HomeMemoryReviewNotice from "$lib/components/home/HomeMemoryReviewNotice.svelte";
import HomeRecent from "$lib/components/home/HomeRecent.svelte";
import HomeSuggestionRail from "$lib/components/home/HomeSuggestionRail.svelte";
import HomeWeeklyBars from "$lib/components/home/HomeWeeklyBars.svelte";
import {
	dayKeyFor,
	greetingFirstName,
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
import type {
	AtlasAvailability,
	AtlasProfile,
} from "$lib/server/services/atlas/public-types";
import type { ConversationDetail } from "$lib/server/services/conversation-detail/types";
import { onDestroy, onMount, tick, untrack } from "svelte";
import type { ConversationDraft } from "$lib/server/services/conversations";
import type {
	ArtifactSummary,
	PendingAttachment,
} from "$lib/server/services/knowledge/types";
import type { LinkedContextSource } from "$lib/server/services/linked-context-sources";

/**
 * `home` is the landing surface; `project` is the same surface for one
 * project, where the greeting is the project's name, the stats line counts its
 * chats and the composer starts a chat inside it.
 */
export type HomeMode =
	| { kind: "home" }
	| {
			kind: "project";
			project: { id: string; name: string };
			/** Slice E fills these two; Slice D renders the instructions half only. */
			fileCount?: number;
			chatCount: number;
			lastActivityAt: number | null;
	  };

interface Props {
	mode: HomeMode;
	/** Already scoped by the caller: all conversations on home, this project's on the project page. */
	recent: HomeRecentConversation[];
	weekly?: HomeWeeklyBucket[];
	weeklyTotal?: number;
	/**
	 * True from the moment this surface's send handler starts, and never false
	 * again. The route binds it to stop its summary poll during the hand-off to
	 * the chat page — the flag itself belongs to the surface that sends.
	 */
	sendStarted?: boolean;
	/** Slice G passes its cards here. */
	projectsRow?: never;
	/**
	 * The project half of the quiet line under the composer: the chip reads
	 * "Instructions" once the project has some, "Add instructions" until then.
	 * It comes from the project's own read (where a whitespace-only save is a
	 * clear), never from what the page last sent. Slice E's files chip will sit
	 * beside it. Meaningless outside `project` mode, where nothing renders it.
	 */
	projectHasInstructions?: boolean;
	/**
	 * Land the caret in the composer on mount — set when the page was opened by
	 * the sidebar's "New chat" item, whose whole point is "start typing here".
	 * Unset for every other way in, because focusing a phone's box raises the
	 * keyboard over a page the user may have opened to read.
	 */
	focusComposer?: boolean;
	onOpenInstructions?: () => void;
	onOpenFiles?: () => void;
	/**
	 * The home board's summary, loaded by the route (`GET /api/home/summary`)
	 * and passed down one field at a time. None of it exists on the project
	 * page, which is why every field is optional and every strip that reads one
	 * hides itself when it is missing.
	 */
	running?: HomeRunningJob | null;
	suggestions?: HomeSuggestion[];
	memoryReviewCount?: number;
	memoryReviewNoticeDismissed?: boolean;
	summaryLoaded?: boolean;
	/** The layout `data` fields this surface reads. */
	displayName?: string | null;
	userId?: string | null;
	isAdmin?: boolean;
	maxMessageLength?: number;
	composerCommandRegistryEnabled?: boolean;
	atlasAvailability?: AtlasAvailability | null;
	initialPersonalityId?: string | null;
}

let {
	mode,
	recent = [],
	weekly = [],
	weeklyTotal = 0,
	sendStarted = $bindable(false),
	running = null,
	suggestions = [],
	memoryReviewCount = 0,
	memoryReviewNoticeDismissed = false,
	summaryLoaded = false,
	displayName = null,
	userId = null,
	isAdmin = false,
	maxMessageLength = 10000,
	composerCommandRegistryEnabled = false,
	atlasAvailability = null,
	initialPersonalityId = null,
	projectHasInstructions = false,
	focusComposer = false,
	onOpenInstructions,
}: Props = $props();

// `projectsRow` and `onOpenFiles` complete the caller-facing interface but are
// not read yet: `projectsRow` arrives in Slice G and the files chip — the
// other half of the quiet line — in Slice E.
const isProjectMode = $derived(mode.kind === "project");
const projectId = $derived(mode.kind === "project" ? mode.project.id : null);
const projectName = $derived(mode.kind === "project" ? mode.project.name : "");

// The same clock HomeRecent reads its "3 hours ago" against, so the project's
// stats line and the lines under it cannot disagree about how long ago
// something was.
const formatters = $derived(
	makeGrammarFormatters($uiLanguage, () => nowSeconds * 1000),
);

// "3 chats · active 3 hours ago". The count is the project's total (not the
// capped list's length) and the time is its newest *chat* activity — the same
// column the sidebar's ordering uses, so the two surfaces cannot disagree.
// A project with no chats has no last activity; it says "active now", which is
// true of the page the user just opened onto it.
const projectStats = $derived.by(() => {
	if (mode.kind !== "project") return "";
	const relative = formatters.relative(mode.lastActivityAt ?? nowSeconds);
	return $t(mode.chatCount === 1 ? "projects.statsOne" : "projects.stats", {
		count: mode.chatCount,
		relative,
	});
});

// The list's own head: "3 chats in this project" rather than the landing
// page's "All conversations", because this list is already everything.
const projectListHeading = $derived.by(() => {
	if (mode.kind !== "project") return null;
	return $t(
		mode.chatCount === 1 ? "projects.listHeadingOne" : "projects.listHeading",
		{ count: mode.chatCount },
	);
});

// The composer's empty box names the project it will start a chat in — the one
// place the box can belong to something before the chat exists. Home mode
// passes nothing, which leaves MessageInput on the ordinary placeholder.
const composerPlaceholder = $derived(
	isProjectMode
		? $t("projects.startChatPlaceholder", { name: projectName })
		: null,
);

const quietLineInstructionsLabel = $derived(
	projectHasInstructions
		? $t("projects.instructionsLabel")
		: $t("projects.addInstructions"),
);

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
		(detail.generatedFiles?.length ?? 0) === 0 &&
		// The draft must already belong where this surface would send it. A
		// draft prepared on the landing page has no project and a draft
		// prepared on a project's page has that project: adopting the other
		// one would send the first message into a folder the composer never
		// named, or out of the one it did.
		(detail.conversation.projectId ?? null) === projectId
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

// Incognito, one-way (docs/plans/incognito-one-way-spec.md §2-3). The mask
// button here — and its phone-header twin, see stores/ui.ts — is the ONLY
// place incognito can be armed, and it lasts as long as the decision does:
// until a message has been SENT, not until a conversation exists. Those are
// not the same moment. The landing page creates its conversation from the
// first keystroke (draft persistence) and from the first attachment, so a
// rule keyed on `preparedConversationId` took the button away the instant
// the user started typing — which is the instant most people think "wait,
// not this one". A conversation with no messages in it has had nothing
// learned from it yet, which is exactly the condition the server's own
// empty-conversation PATCH allows (spec §1), so arming one is honest.
// `sendStarted` is the line: it goes true at the top of handleSend and never
// comes back, and the chat page has its own rule for a conversation that
// already carries messages (no button there at all). The armed flag itself
// lives in a shared store (`landingIncognitoArmed`) rather than local state
// so Header's phone button — mounted in the layout, not this page — arms
// the same flag instead of a second copy of it.
let incognitoArmTooltipVisible = $state(false);
// Picked once per mount (not at arm time) so it is ready the instant the
// button is tapped, and stable for the rest of the page's life — no re-roll
// on reactive updates. Only ever shown after arming, so the SSR render (which
// never arms) is unaffected by the client-only Math.random() pick.
let incognitoGreetingIndex = $state(-1);
const incognitoGreeting = $derived.by(() => {
	if (incognitoGreetingIndex < 0) return "";
	const pool = INCOGNITO_GREETINGS[$uiLanguage] ?? INCOGNITO_GREETINGS.en;
	return (
		pool[incognitoGreetingIndex % pool.length] ?? INCOGNITO_GREETINGS.en[0]
	);
});
const showIncognitoArm = $derived(
	shouldShowIncognitoArm({
		messageSendStarted: sendStarted,
		armed: $landingIncognitoArmed,
	}),
);

$effect(() => {
	landingIncognitoArmVisible.set(showIncognitoArm);
});

function armIncognito() {
	landingIncognitoArmed.set(true);
	incognitoArmTooltipVisible = false;
}

/**
 * Drain the "New chat" signal (`stores/ui.ts`), once. Returns whether this
 * call is the one that got it, so the two places that can be standing when
 * it arrives — an already-mounted landing, and a landing mounting because of
 * the navigation that raised it — each do their own half and neither does
 * the other's.
 */
function consumeLandingResetRequest(): boolean {
	if (!get(landingResetRequested)) return false;
	landingResetRequested.set(false);
	return true;
}

/**
 * "New chat" pressed while this page was already the page on screen: the
 * navigation went to the URL it is already on and nothing remounted, so the
 * reset `onMount` would have done has to happen here instead. Without it an
 * armed-but-unsent landing had no way out of incognito at all — the mask
 * button was gone (armed), the tint was on, and every New chat button was a
 * no-op (2026-09-22 bug report).
 *
 * Letting go of the prepared conversation is the other half. A draft typed
 * on an armed landing has already created one, and it is incognito; leaving
 * it attached would put the next message into an incognito conversation
 * under a page that now says it is a normal one. What the user typed is
 * untouched — the composer's text is its own state, and the next keystroke
 * makes a fresh conversation for it.
 */
function resetLandingForNewChat() {
	landingIncognitoArmed.set(false);
	incognitoArmReconciliation = null;

	const staleConversationId = preparedConversationId;
	preparedConversationId = null;
	preparedConversationPromise = null;
	setLandingDraftConversationId(null);
	draftPersistence.clear();
	conversationDraft = null;
	if (staleConversationId) {
		cleanupPreparedConversation({ conversationId: staleConversationId });
	}

	// A new chat gets a new line, as a fresh landing does.
	incognitoGreetingIndex = Math.floor(
		Math.random() * INCOGNITO_GREETINGS.en.length,
	);
}

$effect(() => {
	if (!$landingResetRequested) return;
	untrack(() => {
		if (!consumeLandingResetRequest()) return;
		resetLandingForNewChat();
	});
});

// Arming carries the choice to a conversation that already exists — the
// ordinary case now that the button outlives the draft's own conversation,
// and the racy one before that (a tap landing while the creating POST is
// still in flight, when `preparedConversationId` has not been assigned yet).
// Either way the conversation has no messages in it, which is exactly what
// the server's empty-conversation PATCH allows (spec §1).
//
// A failure here DISARMS rather than shrugging: the stage, the greeting and
// the composer would otherwise go on saying "incognito" over a row that says
// `memory_incognito = 0`, and a promise that is only visually kept is the
// one failure mode incognito cannot have. Disarming puts the button back, so
// the tap can simply be made again.
//
// Keyed on the store alone (Header's phone button arms the same flag without
// going through `armIncognito` above), so it snapshots what exists at the
// instant of the tap and does not re-run when a later, correctly-armed
// creation assigns `preparedConversationId`.
let incognitoArmReconciliation: Promise<void> | null = null;
$effect(() => {
	if (!$landingIncognitoArmed) return;
	untrack(() => {
		if (incognitoArmReconciliation) return;
		const pending = preparedConversationPromise;
		if (!pending && !preparedConversationId) return;
		incognitoArmReconciliation = (async () => {
			// A restored conversation is not settled until its own validation
			// has run: one that turns out to carry messages is discarded here
			// (`restorePreparedConversation`), and re-reading the id afterwards
			// leaves nothing to PATCH — the next creation carries the flag
			// instead, which is the right answer rather than a doomed write.
			if (!pending) await preparedConversationValidationPromise;
			const id = pending ? await pending : preparedConversationId;
			if (!id) return;
			await setConversationMemoryIncognito(id);
			updateConversationMemoryIncognitoLocal(id, true);
		})().catch(() => {
			incognitoArmReconciliation = null;
			landingIncognitoArmed.set(false);
		});
	});
});

// The first name or nothing — see greetingFirstName. The email is deliberately
// NOT a fallback: "Good morning, levente.alf." is an address read aloud, and
// the nameless line is a better sentence than that.
const greetingName = $derived(greetingFirstName(displayName));
let homeComposerLayer = $state<HTMLDivElement | null>(null);
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

// The summary-fed groups (quiet/busy week, back after a gap, running job) are
// gated on `summaryLoaded`, so the first paint draws from the
// generic, time-of-day and weekday lines and the greeting may change once when
// the summary lands a few tens of milliseconds later. That is the honest
// order: those lines assert something about the user's week, and asserting it
// before the read returns would mean asserting it from an empty summary.
const greeting = $derived(
	pickGreeting({
		name: greetingName,
		// The id, not the name: two people called Anna get different lines, and
		// a rename does not reshuffle yours.
		userKey: userId ?? "",
		now: greetingClock,
		language: $uiLanguage,
		summaryLoaded,
		week: {
			counts: weekly.map((week) => week.count),
			total: weeklyTotal,
		},
		running: running ? { kind: running.kind } : null,
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

let composeIntoComposer: ((text: string) => void) | null = null;

function handleComposeReady(compose: (text: string) => void) {
	composeIntoComposer = compose;
}

function handleMemoryReviewDismiss({
	restoreFocus,
}: {
	restoreFocus: boolean;
}) {
	// Fire and forget, same shape as the suggestion-rail events below: the row
	// already hid itself locally (HomeMemoryReviewNotice's own optimistic
	// state), and a failed write only means it may show again next load.
	void dismissMemoryReviewNotice().catch(() => undefined);
	// A keyboard dismissal removes the focused button; hand focus to the
	// composer, the next thing on this screen, instead of dropping it on body.
	if (restoreFocus) {
		void tick().then(() =>
			homeComposerLayer?.querySelector("textarea")?.focus(),
		);
	}
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
	untrack(() => initialPersonalityId) ?? null,
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
			/**
			 * The upload's extraction job rides INSIDE the attachment, on
			 * `PendingAttachment.extraction`. It used to travel beside it only
			 * because that field did not exist when this page was written.
			 */
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
					// The code beside the sentence is what the composer renders,
					// so a Hungarian user reads Hungarian. The sentence stays for
					// a build whose server has not shipped the codes yet.
					readinessErrorCode: isAttachmentReadinessReason(
						result.readinessErrorCode,
					)
						? result.readinessErrorCode
						: null,
					extraction: extractionFromUploadResponse(result) ?? undefined,
				},
			};
		}
		return {
			success: false,
			fileName: file.name,
			error: $t("knowledge.uploadFailedFallback"),
		};
	} catch (err) {
		// A refused type answers with an i18n key; the `error` string beside it
		// is English whatever the user's language is.
		const refusal = uploadRefusalFromError(err, file);
		return {
			success: false,
			fileName: file.name,
			error: refusal
				? $t(refusal.key, refusal.params)
				: err instanceof Error
					? err.message
					: $t("knowledge.uploadFailedFallback"),
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
	// A fresh landing visit always starts unarmed — this is a shared store
	// (Header's phone button reads/writes it too), so a previous visit's
	// true must not leak into this one. `landingIncognitoArmVisible` is NOT
	// reset here as well: it is entirely effect-driven from
	// `showIncognitoArm` below, and setting it here too raced that effect —
	// whichever ran second won, and onMount running after the effect's
	// first (correct) pass silently pinned it back to false for the rest of
	// the visit.
	landingIncognitoArmed.set(false);

	const previousId = consumePreviousConversationId();
	if (previousId) {
		isFromChat = true;
		setTimeout(() => {
			animateIn = true;
		}, 50);
	} else {
		animateIn = true;
	}

	// Arriving because "New chat" was pressed somewhere else: do not resume
	// the landing draft's own conversation. It may be the incognito one the
	// user is walking away from, and "new" is the whole request. Drained
	// here, before the restore below reads it, so the effect above finds
	// nothing left to do on this mount.
	if (consumeLandingResetRequest()) {
		const staleConversationId = getLandingDraftConversationId();
		setLandingDraftConversationId(null);
		if (staleConversationId) {
			cleanupPreparedConversation({ conversationId: staleConversationId });
		}
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

	// Incognito greeting pick — client-only (see the field's own comment) and
	// independent of the picked-once-per-day memory below, on purpose: this
	// line is not trying to avoid repeating itself across visits the way the
	// normal greeting does, only within a single mount.
	incognitoGreetingIndex = Math.floor(
		Math.random() * INCOGNITO_GREETINGS.en.length,
	);

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

	// The clock the board's relative times are read against. It ticks every 15
	// seconds so the running line's elapsed time does not sit still between
	// summary polls; the polling itself is the route's (it owns the summary).
	const clockTimer = setInterval(() => {
		nowSeconds = Math.floor(Date.now() / 1000);
	}, 15_000);
	return () => {
		clearInterval(clockTimer);
	};
});

onDestroy(() => {
	void draftPersistence.flush();
	// Leaving the landing page — Header's phone mask button must not keep
	// showing (or keep armable) for a route that is no longer this page.
	landingIncognitoArmVisible.set(false);
	// And the armed flag goes with it. `onMount` resets it too, but on a
	// client-side return to "/" (arm, open Knowledge, come back) that reset
	// lands a beat after the first paint, which would otherwise be a landing
	// page dressed as incognito over a conversation that is not.
	landingIncognitoArmed.set(false);
});

async function ensurePreparedConversation(): Promise<string> {
	if (preparedConversationValidationPromise) {
		await preparedConversationValidationPromise;
	}
	if (preparedConversationId) {
		return preparedConversationId;
	}
	if (!preparedConversationPromise) {
		preparedConversationPromise = createNewConversation({
			memoryIncognito: $landingIncognitoArmed,
			projectId,
		})
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

	sendStarted = true;
	creating = true;
	error = null;
	pendingMessagePreview = text;

	try {
		const id = payload.conversationId ?? (await ensurePreparedConversation());
		// Incognito, one-way: if the arm landed on a conversation that was
		// already being created, the PATCH that carries it to the server is
		// still in flight — and once this send stores a message the server
		// refuses it (spec §1, `incognito_requires_empty_conversation`). Wait
		// for it rather than race it.
		if (incognitoArmReconciliation) await incognitoArmReconciliation;
		currentConversationId.set(id);
		upsertConversationLocal(
			id,
			"New Conversation",
			Date.now() / 1000,
			undefined,
			$landingIncognitoArmed,
		);
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
			// The project rides with the pending message as well as being set on
			// the creation above, so the first turn's home survives the hand-off
			// even when the conversation was already prepared.
			projectId,
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
		error = $t("chat.failedCreateConversation");
		sendStarted = false;
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
		// Incognito, one-way: the armed flag itself is page state and does not
		// survive a reload, but the conversation it was applied to does. A
		// reload after arming and typing (the draft created the conversation)
		// would otherwise come back with the tint, the greeting, the dashed
		// composer and the mask face all gone, over a conversation that is
		// incognito for the rest of its life — the promise kept, but invisibly,
		// which is its own kind of wrong. The stored row is the truth here.
		if (payload.conversation.memoryIncognito) {
			// Already true on the server, so nothing for the reconciliation
			// above to carry there — claim it before arming, or arming would
			// send a PATCH that only repeats what the row already says.
			incognitoArmReconciliation ??= Promise.resolve();
			landingIncognitoArmed.set(true);
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
		if (sendStarted || creating) {
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

<div
	class="chat-page flex h-full min-w-0 flex-col bg-surface-page"
	role="region"
	aria-label={$t('chat.landingRegionLabel')}
	ondragenter={handleDragEnter}
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
>
	<DropZoneOverlay active={fileDragActive} rejected={fileDragRejected} />
	<div
		class="chat-stage relative flex min-h-0 flex-1 overflow-hidden rounded-lg"
		class:stage--incognito={$landingIncognitoArmed}
	>
		<!-- Incognito, one-way (spec §2) — the ONLY place the flag can be
		     armed, and only while no conversation exists yet. Tapping it arms
		     incognito locally (MessageInput's own state, fed by the
		     memoryIncognito prop below) and the button fades out; the
		     conversation is created with memoryIncognito: true the moment one
		     is first needed, never before. -->
		{#if showIncognitoArm}
			<div class="incognito-arm-wrap" transition:statusFade={{ duration: 150 }}>
				<button
					type="button"
					class="incognito-arm"
					data-testid="incognito-arm"
					aria-label={$t('chat.incognitoArm')}
					aria-describedby="incognito-arm-tooltip"
					onclick={armIncognito}
					onmouseenter={() => (incognitoArmTooltipVisible = true)}
					onmouseleave={() => (incognitoArmTooltipVisible = false)}
					onfocus={() => (incognitoArmTooltipVisible = true)}
					onblur={() => (incognitoArmTooltipVisible = false)}
				>
					<VenetianMask size={20} strokeWidth={1.8} aria-hidden="true" />
				</button>
				{#if incognitoArmTooltipVisible}
					<!-- The button's accessible name says what tapping it does; the
					     one-way rule is only in here, so the button points at it
					     rather than leaving a screen reader with the name alone.
					     Focus opens the tooltip, so the description is present by
					     the time it is read. -->
					<div
						class="incognito-arm-tooltip"
						id="incognito-arm-tooltip"
						role="tooltip"
						data-testid="incognito-arm-tooltip"
						transition:statusFade={{ duration: 120 }}
					>
						<div class="incognito-arm-tooltip__title">{$t('chat.incognitoArmTitle')}</div>
						<div class="incognito-arm-tooltip__body">{$t('chat.incognitoArmBody')}</div>
					</div>
				{/if}
			</div>
		{/if}

		<div
			bind:this={homeComposerLayer}
			class="composer-layer"
			class:composer-layer-animate={isFromChat && animateIn}
			class:composer-layer-no-animate={!isFromChat}
			class:composer-layer-handoff={sendStarted}
		>
			<div class="home-column mx-auto flex w-full max-w-[780px] flex-col px-1">
				{#if !sendStarted}
					<!-- The greeting carries the record on its own line: on the landing
					     page the twelve weekly bars and the week's count, on a project's
					     page the count of its chats and when the newest one moved,
					     right-aligned and sitting on the greeting's baseline. Armed
					     incognito replaces both with a single italic line — nothing here
					     is counted, so the record goes with the rest of the board. -->
					<div class="home-band" in:greetingFade={{ duration: isFromChat ? 400 : 0, delay: isFromChat ? 100 : 0 }}>
						{#if isProjectMode}
							<!-- The project's name is the page's anchor, armed or not: the
							     tint and the italic face are what say "this chat is not
							     remembered", and swapping the name for a greeting would
							     take away the one thing telling the user where they are. -->
							<h1
								class="home-greeting"
								class:home-greeting--incognito={$landingIncognitoArmed}
								data-testid="project-greeting"
							>{projectName}</h1>
							{#if !$landingIncognitoArmed}
								<span class="project-stats" data-testid="project-stats">{projectStats}</span>
							{/if}
						{:else if $landingIncognitoArmed}
							<h1 class="home-greeting home-greeting--incognito" data-testid="home-greeting">
								{incognitoGreeting}
							</h1>
						{:else}
							<h1 class="home-greeting" data-testid="home-greeting">
								<span class="home-greeting-full">{activeGreeting}</span>
								<span class="home-greeting-plain">{greetingPlain}</span>
							</h1>
							<HomeWeeklyBars weeks={weekly} total={weeklyTotal} />
						{/if}
					</div>

					{#if !isProjectMode && !$landingIncognitoArmed && summaryLoaded}
						<!-- Directly under the greeting band, above the composer. Keyed
						     by the server's own dismissed flag: when a NEW review item
						     makes it flip from dismissed back to not-dismissed, the key
						     changes and Svelte remounts the row, clearing its local
						     optimistic-hide state rather than leaving it stuck hidden
						     from an earlier dismissal (see HomeMemoryReviewNotice). -->
						{#key memoryReviewNoticeDismissed}
							<HomeMemoryReviewNotice
								count={memoryReviewNoticeDismissed ? 0 : memoryReviewCount}
								href="/knowledge?tab=memory#memory-review"
								onDismiss={handleMemoryReviewDismiss}
							/>
						{/key}
					{/if}
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
					maxLength={maxMessageLength}
					showSlashHintProp={false}
					composerCommandRegistryEnabled={composerCommandRegistryEnabled}
					conversationId={preparedConversationId}
					memoryIncognito={$landingIncognitoArmed}
					onMemoryIncognitoChange={(value, id) =>
						updateConversationMemoryIncognitoLocal(id, value)}
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
					atlasAvailability={atlasAvailability}
					onUploadFiles={handleUploadFiles}
					placeholder={composerPlaceholder}
					autofocus={focusComposer}
				/>

				{#if isProjectMode && !sendStarted}
					<!-- The quiet line under the composer: what this project carries
					     into every chat in it. Instructions only for now — Slice E adds
					     the paperclip and the files chip beside it, in this same row.
					     It stays while incognito is armed, because an incognito chat in
					     a project still follows the project's instructions. -->
					<div class="project-quiet-line" data-testid="project-quiet-line">
						<button
							type="button"
							class="project-quiet-chip"
							data-testid="project-instructions-button"
							onclick={() => onOpenInstructions?.()}
						>
							<Pencil size={13} strokeWidth={1.9} aria-hidden="true" />
							{quietLineInstructionsLabel}
						</button>
					</div>
				{/if}

				{#if !sendStarted && !$landingIncognitoArmed && (summaryLoaded || isProjectMode)}
					<!-- Armed incognito hides the whole board: no history, no
					     counting, just the greeting and the composer (spec §3). The
					     project page's board is its chats, which is history, so it goes
					     with the rest. -->
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
							suggestions={suggestions}
							disabled={creating}
							onPick={handleSuggestionPick}
						/>

						<HomeRecent
							recent={recent}
							running={running}
							{nowSeconds}
							heading={projectListHeading}
							emptyLine={isProjectMode ? $t('projects.emptyList') : null}
							onAllConversations={requestSearchModalOpen}
						/>

						<div class="home-strip">
							<DegradedCapabilitiesBanner
								isAdmin={isAdmin}
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

	/* The project page's record, where the landing page puts its weekly bars:
	   right end of the greeting's line, quiet enough not to compete with the
	   project's name, and it never wraps under it. */
	.project-stats {
		flex-shrink: 0;
		font-size: 0.72rem;
		color: var(--text-muted);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
		padding-bottom: 6px;
	}

	@media (max-width: 767px) {
		.project-stats {
			font-size: 0.7rem;
		}
	}

	/* The quiet line under the composer: a row of small chips, each opening the
	   modal for what it names. Instructions today; Slice E's files chip joins
	   the row on the same terms. */
	.project-quiet-line {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 8px;
		padding: 0 2px;
	}

	.project-quiet-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 6px;
		border: none;
		border-radius: var(--radius-sm);
		background: none;
		font-size: 0.78rem;
		color: var(--text-muted);
		cursor: pointer;
		transition: color var(--duration-standard) var(--ease-out);
	}

	.project-quiet-chip:hover,
	.project-quiet-chip:focus-visible {
		color: var(--accent);
	}

	/* A chip is still a control on a phone: the 30px face keeps a 44px hit area
	   around it, the same rule the board's own chips follow. The target grows
	   vertically only — Slice E's files chip lands beside this one, and a
	   horizontal overhang would make the two boundaries overlap. */
	@media (max-width: 767px) {
		.project-quiet-chip {
			position: relative;
			min-height: 30px;
		}

		.project-quiet-chip::after {
			content: '';
			position: absolute;
			inset: -7px 0;
		}
	}

	/* Incognito, one-way (spec §3) — the greeting is the cue once armed:
	   italic, in the serif face, a touch softer than the normal greeting's
	   accent-mixed colour (which would read as "still counting"). */
	.home-greeting--incognito {
		font-style: italic;
		color: color-mix(in srgb, var(--text-primary) 88%, transparent 12%);
	}

	/* ── The incognito arm button (spec §2) ──────────────────────────────
	   The only place the flag can be armed: a 40px round icon button,
	   top-right of the stage, gone the instant a conversation exists by any
	   route (tapped, or an attachment creating one first). Below the same
	   1024px ("lg") breakpoint Header.svelte's own `lg:hidden` phone bar
	   uses, the phone header draws its own mask button in that bar instead
	   — this one steps aside there rather than drawing a second, redundant
	   control the mockup never shows both of at once. */
	.incognito-arm-wrap {
		position: absolute;
		top: 18px;
		right: 22px;
		z-index: 5;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 8px;
	}

	@media (max-width: 1023px) {
		.incognito-arm-wrap {
			display: none;
		}
	}

	.incognito-arm {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border: 1px solid var(--border-default);
		border-radius: 9999px;
		background: var(--surface-elevated);
		color: var(--text-secondary);
		box-shadow: var(--shadow-sm);
		cursor: pointer;
		transition:
			color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out);
	}

	.incognito-arm:hover,
	.incognito-arm:focus-visible {
		color: var(--text-primary);
		border-color: var(--border-focus);
	}

	.incognito-arm:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* 44px hit area on a coarse pointer, without growing the 40px glyph the
	   mockup specifies — the button keeps its visual size and gains padding
	   that pushes the box (border-box) out to the touch target. */
	@media (pointer: coarse) {
		.incognito-arm {
			width: 44px;
			height: 44px;
		}
	}

	.incognito-arm-tooltip {
		max-width: 220px;
		border-radius: 8px;
		background: var(--text-primary);
		padding: 8px 10px;
		box-shadow: var(--shadow-lg);
		font-family: var(--font-sans);
		font-size: 12px;
		line-height: 1.35;
		color: var(--surface-page);
	}

	.incognito-arm-tooltip__title {
		font-weight: 600;
	}

	.incognito-arm-tooltip__body {
		margin-top: 2px;
		color: color-mix(in srgb, var(--surface-page) 82%, var(--text-muted) 18%);
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

		/* Even a first name pushes the greeting to a third line at 390px. */
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
