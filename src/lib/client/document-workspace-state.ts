import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";

export type WorkspacePresentation = "docked" | "expanded";

export type WorkspaceDocumentState = {
	documents: DocumentWorkspaceItem[];
	activeDocumentId: string | null;
	isOpen: boolean;
};

/**
 * The chat a panel belongs to. The tab remembers a panel per chat, and each
 * says whose it is, so a chat restores its own panel whole, and what another
 * chat left is only carried as far as it is meant to travel. `incognito` is
 * recorded because an item itself does not say (`conversationId` is an id, and
 * a library open carries none).
 */
export type WorkspaceConversation = {
	conversationId: string;
	incognito: boolean;
};

export type PersistedWorkspaceDocumentState = WorkspaceDocumentState & {
	presentation: WorkspacePresentation;
	updatedAt: number;
	/** Whose panel this is. Absent on a panel stored before it was recorded. */
	conversation?: WorkspaceConversation;
};

/**
 * What the tab's storage holds: the panel saved last, in the shape this key
 * has always had, and under `others` the panels of the chats saved before it,
 * newest first. A value written before there was `others` is one panel and
 * reads as one.
 */
type PersistedWorkspaceValue = PersistedWorkspaceDocumentState & {
	others?: PersistedWorkspaceDocumentState[];
};

type WorkspaceEventTarget = Pick<Window, "dispatchEvent">;

const CHAT_WORKSPACE_STATE_STORAGE_KEY = "alfyai-chat-document-workspace";
const MAX_PERSISTED_DOCUMENTS = 12;
/** How many chats' panels the tab remembers; the chat visited longest ago goes first. */
const MAX_PERSISTED_PANELS = 20;
const MAX_PERSISTED_STATE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const WORKSPACE_CONVERSATION_DELETED_EVENT =
	"alfyai:workspace-conversation-deleted";

export function reduceWorkspaceDocumentOpen(
	documents: DocumentWorkspaceItem[],
	document: DocumentWorkspaceItem,
): WorkspaceDocumentState {
	const alreadyOpen = documents.some((entry) => entry.id === document.id);
	const updatedDocuments = alreadyOpen
		? documents.map((entry) =>
				entry.id === document.id ? { ...entry, ...document } : entry,
			)
		: [...documents, document];

	return {
		documents: updatedDocuments,
		activeDocumentId: document.id,
		isOpen: true,
	};
}

export function reduceWorkspaceDocumentClose(
	documents: DocumentWorkspaceItem[],
	documentId: string,
	activeWorkspaceDocumentId: string | null,
): WorkspaceDocumentState {
	const remainingDocuments = documents.filter(
		(document) => document.id !== documentId,
	);
	let nextActiveId = activeWorkspaceDocumentId;

	if (activeWorkspaceDocumentId === documentId) {
		nextActiveId = remainingDocuments.at(-1)?.id ?? null;
	}

	return {
		documents: remainingDocuments,
		activeDocumentId: nextActiveId,
		isOpen: remainingDocuments.length > 0,
	};
}

export function reduceWorkspaceClose(
	documents: DocumentWorkspaceItem[],
	activeWorkspaceDocumentId: string | null,
): WorkspaceDocumentState {
	if (documents.length <= 1) {
		return {
			documents: [],
			activeDocumentId: null,
			isOpen: false,
		};
	}

	const activeDocumentId =
		activeWorkspaceDocumentId &&
		documents.some((document) => document.id === activeWorkspaceDocumentId)
			? activeWorkspaceDocumentId
			: (documents.at(-1)?.id ?? null);

	return {
		documents,
		activeDocumentId,
		isOpen: false,
	};
}

function isWorkspaceDocumentFromConversation(
	document: DocumentWorkspaceItem,
	conversationId: string,
): boolean {
	return (
		document.conversationId === conversationId ||
		document.originConversationId === conversationId
	);
}

export function reduceWorkspaceDocumentsForDeletedConversation(
	documents: DocumentWorkspaceItem[],
	deletedConversationId: string,
	activeWorkspaceDocumentId: string | null,
): WorkspaceDocumentState {
	const remainingDocuments = documents.filter(
		(document) =>
			!isWorkspaceDocumentFromConversation(document, deletedConversationId),
	);
	const activeDocumentId =
		activeWorkspaceDocumentId &&
		remainingDocuments.some(
			(document) => document.id === activeWorkspaceDocumentId,
		)
			? activeWorkspaceDocumentId
			: (remainingDocuments.at(-1)?.id ?? null);

	return {
		documents: remainingDocuments,
		activeDocumentId,
		isOpen: remainingDocuments.length > 0,
	};
}

function parseWorkspaceConversation(
	value: unknown,
): WorkspaceConversation | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { conversationId, incognito } = value as Partial<WorkspaceConversation>;
	if (typeof conversationId !== "string" || conversationId === "") {
		return undefined;
	}
	return { conversationId, incognito: incognito === true };
}

/** One stored panel as it is, whoever it belongs to. `now: null` skips the age limit. */
function parsePersistedPanel(
	value: unknown,
	now: number | null,
): PersistedWorkspaceDocumentState | null {
	if (!value || typeof value !== "object") return null;
	const parsed = value as Partial<PersistedWorkspaceDocumentState>;
	if (!Array.isArray(parsed.documents)) return null;
	if (
		now !== null &&
		typeof parsed.updatedAt === "number" &&
		now - parsed.updatedAt > MAX_PERSISTED_STATE_AGE_MS
	) {
		return null;
	}

	const conversation = parseWorkspaceConversation(parsed.conversation);
	const documents = parsed.documents.filter(
		(document): document is DocumentWorkspaceItem =>
			Boolean(
				document &&
					typeof document.id === "string" &&
					typeof document.filename === "string" &&
					typeof document.source === "string",
			),
	);
	// A chat whose panel was emptied keeps its (empty) panel, so what an older
	// chat still has open is not handed to the next chat behind its back. One
	// that does not say whose it is has nothing to keep.
	if (documents.length === 0 && !conversation) return null;

	const activeDocumentId =
		typeof parsed.activeDocumentId === "string" &&
		documents.some((document) => document.id === parsed.activeDocumentId)
			? parsed.activeDocumentId
			: (documents.at(-1)?.id ?? null);

	return {
		documents,
		activeDocumentId,
		isOpen: parsed.isOpen === true,
		presentation: parsed.presentation === "expanded" ? "expanded" : "docked",
		updatedAt:
			typeof parsed.updatedAt === "number" ? parsed.updatedAt : (now ?? 0),
		conversation,
	};
}

/** Every panel the tab remembers, the one saved last first. */
function readPersistedPanels(
	storage: Pick<Storage, "getItem"> | null | undefined,
	now: number | null,
): PersistedWorkspaceDocumentState[] {
	if (!storage) return [];

	const raw = storage.getItem(CHAT_WORKSPACE_STATE_STORAGE_KEY);
	if (!raw) return [];

	try {
		const value = JSON.parse(raw) as { others?: unknown } | null;
		const others = value && Array.isArray(value.others) ? value.others : [];
		const panels: PersistedWorkspaceDocumentState[] = [];
		const seen = new Set<string>();
		for (const candidate of [value, ...others]) {
			const panel = parsePersistedPanel(candidate, now);
			if (!panel) continue;
			const id = panel.conversation?.conversationId;
			if (id !== undefined) {
				if (seen.has(id)) continue;
				seen.add(id);
			}
			panels.push(panel);
		}
		return panels;
	} catch {
		return [];
	}
}

/** Stores `panels` (the one saved last first), the last few chats' worth. */
function writePersistedPanels(
	storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined,
	panels: PersistedWorkspaceDocumentState[],
): void {
	if (!storage) return;

	const kept = panels.slice(0, MAX_PERSISTED_PANELS);
	if (kept.every((panel) => panel.documents.length === 0)) {
		storage.removeItem(CHAT_WORKSPACE_STATE_STORAGE_KEY);
		return;
	}

	const [newest, ...others] = kept;
	storage.setItem(
		CHAT_WORKSPACE_STATE_STORAGE_KEY,
		JSON.stringify({
			...newest,
			...(others.length > 0 ? { others } : {}),
		} satisfies PersistedWorkspaceValue),
	);
}

/** An item no chat owns: a library or search open, or a source opened from a citation. */
function isWorkspaceDocumentFromNoConversation(
	document: DocumentWorkspaceItem,
): boolean {
	return !document.conversationId && !document.originConversationId;
}

/** A panel that belongs to an incognito chat other than the one asking. */
function isOtherIncognitoPanel(
	panel: PersistedWorkspaceDocumentState,
	asking: WorkspaceConversation,
): boolean {
	return (
		panel.conversation?.incognito === true &&
		panel.conversation.conversationId !== asking.conversationId
	);
}

/**
 * What `conversation`'s panel restores from what the tab remembers: the panel
 * a chat is shown after a reload, or when the tab moves from one chat to
 * another.
 *
 * - A chat with a panel of its own gets that panel back whole, an item its
 *   parent made included, whatever chats were visited since.
 * - A chat with none takes what the chat visited last left: only what belongs
 *   to this chat (`conversationId` / `originConversationId`) and the library
 *   and search opens that belong to none. If the item that was on screen was
 *   not carried, the panel stays closed rather than opening on a stranger.
 * - An incognito chat's panel goes nowhere else: it is not restored, and it is
 *   removed from storage on the spot. An incognito chat likewise starts with
 *   nothing of another chat's.
 * - A panel stored before it said whose it is gives only this chat's own items.
 */
export function loadPersistedWorkspaceDocumentState(
	storage:
		| Pick<Storage, "getItem" | "setItem" | "removeItem">
		| null
		| undefined,
	conversation: WorkspaceConversation,
	now = Date.now(),
): PersistedWorkspaceDocumentState | null {
	const stored = readPersistedPanels(storage, now);
	const panels = stored.filter(
		(panel) => !isOtherIncognitoPanel(panel, conversation),
	);
	if (panels.length < stored.length) writePersistedPanels(storage, panels);

	const own = panels.find(
		(panel) =>
			panel.conversation?.conversationId === conversation.conversationId,
	);
	if (own && own.documents.length > 0) return { ...own, conversation };

	const carriedFrom = panels[0];
	if (!carriedFrom || carriedFrom.documents.length === 0) return null;

	const carriesUnownedOpens =
		Boolean(carriedFrom.conversation) && !conversation.incognito;
	const documents = carriedFrom.documents.filter(
		(document) =>
			isWorkspaceDocumentFromConversation(
				document,
				conversation.conversationId,
			) ||
			(carriesUnownedOpens && isWorkspaceDocumentFromNoConversation(document)),
	);
	if (documents.length === 0) return null;

	const activeCarried = documents.some(
		(document) => document.id === carriedFrom.activeDocumentId,
	);
	const isOpen = activeCarried && carriedFrom.isOpen;
	return {
		documents,
		activeDocumentId: activeCarried
			? carriedFrom.activeDocumentId
			: (documents.at(-1)?.id ?? null),
		isOpen,
		presentation: isOpen ? carriedFrom.presentation : "docked",
		updatedAt: carriedFrom.updatedAt,
		conversation,
	};
}

/**
 * Stores `state` as `state.conversation`'s panel, which becomes the newest of
 * the chats the tab remembers. Another incognito chat's panel is not kept
 * beside it.
 */
export function savePersistedWorkspaceDocumentState(
	storage:
		| Pick<Storage, "getItem" | "setItem" | "removeItem">
		| null
		| undefined,
	state: {
		documents: DocumentWorkspaceItem[];
		activeDocumentId: string | null;
		isOpen: boolean;
		presentation: WorkspacePresentation;
		conversation: WorkspaceConversation;
	},
	now = Date.now(),
): void {
	if (!storage) return;

	const documents = state.documents.slice(-MAX_PERSISTED_DOCUMENTS);
	const activeDocumentId =
		state.activeDocumentId &&
		documents.some((document) => document.id === state.activeDocumentId)
			? state.activeDocumentId
			: (documents.at(-1)?.id ?? null);
	const others = readPersistedPanels(storage, now).filter(
		(panel) =>
			panel.conversation !== undefined &&
			panel.conversation.conversationId !== state.conversation.conversationId &&
			!panel.conversation.incognito,
	);

	writePersistedPanels(storage, [
		{
			documents,
			activeDocumentId,
			isOpen: state.isOpen,
			presentation: state.presentation,
			updatedAt: now,
			conversation: state.conversation,
		},
		...others,
	]);
}

/**
 * An incognito chat is left: what it kept for its own reload does not stay in
 * the tab's storage. A normal chat's panel, and another incognito chat's, are
 * left alone.
 */
export function discardPersistedWorkspaceDocumentStateOfIncognitoConversation(
	storage:
		| Pick<Storage, "getItem" | "setItem" | "removeItem">
		| null
		| undefined,
	conversationId: string,
): void {
	const panels = readPersistedPanels(storage, null);
	const remaining = panels.filter(
		(panel) =>
			!(
				panel.conversation?.incognito &&
				panel.conversation.conversationId === conversationId
			),
	);
	if (remaining.length < panels.length)
		writePersistedPanels(storage, remaining);
}

/**
 * A chat was deleted: its own panel goes, and what it made is taken out of the
 * panels of the other chats (an item a fork's panel shows, a library open is
 * not touched). Answers the panel saved last as it is left, or null when
 * nothing is open in it.
 */
export function removeConversationFromPersistedWorkspaceDocumentState(
	storage:
		| Pick<Storage, "getItem" | "setItem" | "removeItem">
		| null
		| undefined,
	conversationId: string,
	now = Date.now(),
): PersistedWorkspaceDocumentState | null {
	const panels = readPersistedPanels(storage, now);
	if (panels.length === 0) return null;

	const remaining = panels
		.filter((panel) => panel.conversation?.conversationId !== conversationId)
		.map((panel) => {
			const next = reduceWorkspaceDocumentsForDeletedConversation(
				panel.documents,
				conversationId,
				panel.activeDocumentId,
			);
			if (next.documents.length === panel.documents.length) return panel;
			const isOpen = panel.isOpen && next.isOpen;
			return {
				...panel,
				documents: next.documents,
				activeDocumentId: next.activeDocumentId,
				isOpen,
				presentation: isOpen ? panel.presentation : "docked",
			};
		});

	writePersistedPanels(storage, remaining);

	const newest = remaining[0];
	return newest && newest.documents.length > 0 ? newest : null;
}

export function dispatchWorkspaceConversationDeleted(
	conversationId: string,
	target:
		| WorkspaceEventTarget
		| null
		| undefined = getDefaultWorkspaceEventTarget(),
): void {
	target?.dispatchEvent(
		new CustomEvent(WORKSPACE_CONVERSATION_DELETED_EVENT, {
			detail: { conversationId },
		}),
	);
}

function getDefaultWorkspaceEventTarget(): WorkspaceEventTarget | null {
	return typeof window === "undefined" ? null : window;
}
