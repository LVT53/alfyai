import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";

export type WorkspacePresentation = "docked" | "expanded";

export type WorkspaceDocumentState = {
	documents: DocumentWorkspaceItem[];
	activeDocumentId: string | null;
	isOpen: boolean;
};

/**
 * The chat a panel belongs to. The stored state is ONE record for the whole
 * browser tab, so it says whose panel it is: a chat restores its own panel
 * whole, and what another chat left there only as far as it is meant to
 * travel. `incognito` is recorded because an item itself does not say
 * (`conversationId` is an id, and a library open carries none).
 */
export type WorkspaceConversation = {
	conversationId: string;
	incognito: boolean;
};

export type PersistedWorkspaceDocumentState = WorkspaceDocumentState & {
	presentation: WorkspacePresentation;
	updatedAt: number;
	/** Whose panel this is. Absent on a record written before it was recorded. */
	conversation?: WorkspaceConversation;
};

type WorkspaceEventTarget = Pick<Window, "dispatchEvent">;

const CHAT_WORKSPACE_STATE_STORAGE_KEY = "alfyai-chat-document-workspace";
const MAX_PERSISTED_DOCUMENTS = 12;
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

/** The stored record as it is, whoever it belongs to. `now: null` skips the age limit. */
function readPersistedRecord(
	storage: Pick<Storage, "getItem"> | null | undefined,
	now: number | null,
): PersistedWorkspaceDocumentState | null {
	if (!storage) return null;

	const raw = storage.getItem(CHAT_WORKSPACE_STATE_STORAGE_KEY);
	if (!raw) return null;

	try {
		const parsed = JSON.parse(raw) as Partial<PersistedWorkspaceDocumentState>;
		if (!Array.isArray(parsed.documents)) return null;
		if (
			now !== null &&
			typeof parsed.updatedAt === "number" &&
			now - parsed.updatedAt > MAX_PERSISTED_STATE_AGE_MS
		) {
			return null;
		}

		const documents = parsed.documents.filter(
			(document): document is DocumentWorkspaceItem =>
				Boolean(
					document &&
						typeof document.id === "string" &&
						typeof document.filename === "string" &&
						typeof document.source === "string",
				),
		);
		if (documents.length === 0) return null;

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
			conversation: parseWorkspaceConversation(parsed.conversation),
		};
	} catch {
		return null;
	}
}

function writePersistedRecord(
	storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined,
	state: {
		documents: DocumentWorkspaceItem[];
		activeDocumentId: string | null;
		isOpen: boolean;
		presentation: WorkspacePresentation;
		conversation?: WorkspaceConversation;
	},
	now: number,
): void {
	if (!storage) return;

	if (state.documents.length === 0) {
		storage.removeItem(CHAT_WORKSPACE_STATE_STORAGE_KEY);
		return;
	}

	const documents = state.documents.slice(-MAX_PERSISTED_DOCUMENTS);
	const activeDocumentId =
		state.activeDocumentId &&
		documents.some((document) => document.id === state.activeDocumentId)
			? state.activeDocumentId
			: (documents.at(-1)?.id ?? null);

	storage.setItem(
		CHAT_WORKSPACE_STATE_STORAGE_KEY,
		JSON.stringify({
			documents,
			activeDocumentId,
			isOpen: state.isOpen,
			presentation: state.presentation,
			updatedAt: now,
			conversation: state.conversation,
		} satisfies PersistedWorkspaceDocumentState),
	);
}

/** An item no chat owns: a library or search open, or a source opened from a citation. */
function isWorkspaceDocumentFromNoConversation(
	document: DocumentWorkspaceItem,
): boolean {
	return !document.conversationId && !document.originConversationId;
}

/**
 * What `conversation`'s panel restores from the stored record: the panel a
 * chat is shown after a reload, or when the tab moves from one chat to another.
 *
 * - The chat's own panel comes back whole, an item its parent made included.
 * - Another normal chat's panel gives only what belongs to this chat
 *   (`conversationId` / `originConversationId`) and the library and search
 *   opens that belong to none. If the item that was on screen was not carried,
 *   the panel stays closed rather than opening on a stranger.
 * - An incognito chat's panel goes nowhere else: it is not restored, and it is
 *   removed from storage on the spot. An incognito chat likewise starts with
 *   nothing of another chat's.
 * - A record written before it said whose panel it is gives only this chat's
 *   own items.
 */
export function loadPersistedWorkspaceDocumentState(
	storage: Pick<Storage, "getItem" | "removeItem"> | null | undefined,
	conversation: WorkspaceConversation,
	now = Date.now(),
): PersistedWorkspaceDocumentState | null {
	const persisted = readPersistedRecord(storage, now);
	if (!persisted) return null;

	const saved = persisted.conversation;
	if (saved?.conversationId === conversation.conversationId) {
		return { ...persisted, conversation };
	}
	if (saved?.incognito) {
		storage?.removeItem(CHAT_WORKSPACE_STATE_STORAGE_KEY);
		return null;
	}

	const carriesUnownedOpens = Boolean(saved) && !conversation.incognito;
	const documents = persisted.documents.filter(
		(document) =>
			isWorkspaceDocumentFromConversation(
				document,
				conversation.conversationId,
			) ||
			(carriesUnownedOpens && isWorkspaceDocumentFromNoConversation(document)),
	);
	if (documents.length === 0) return null;

	const activeCarried = documents.some(
		(document) => document.id === persisted.activeDocumentId,
	);
	const isOpen = activeCarried && persisted.isOpen;
	return {
		documents,
		activeDocumentId: activeCarried
			? persisted.activeDocumentId
			: (documents.at(-1)?.id ?? null),
		isOpen,
		presentation: isOpen ? persisted.presentation : "docked",
		updatedAt: persisted.updatedAt,
		conversation,
	};
}

export function savePersistedWorkspaceDocumentState(
	storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined,
	state: {
		documents: DocumentWorkspaceItem[];
		activeDocumentId: string | null;
		isOpen: boolean;
		presentation: WorkspacePresentation;
		conversation: WorkspaceConversation;
	},
	now = Date.now(),
): void {
	writePersistedRecord(storage, state, now);
}

/**
 * An incognito chat is left: what it kept for its own reload does not stay in
 * the tab's storage. A normal chat's panel, and another incognito chat's, are
 * left alone.
 */
export function discardPersistedWorkspaceDocumentStateOfIncognitoConversation(
	storage: Pick<Storage, "getItem" | "removeItem"> | null | undefined,
	conversationId: string,
): void {
	const saved = readPersistedRecord(storage, null)?.conversation;
	if (saved?.incognito && saved.conversationId === conversationId) {
		storage?.removeItem(CHAT_WORKSPACE_STATE_STORAGE_KEY);
	}
}

export function removeConversationFromPersistedWorkspaceDocumentState(
	storage:
		| Pick<Storage, "getItem" | "setItem" | "removeItem">
		| null
		| undefined,
	conversationId: string,
	now = Date.now(),
): PersistedWorkspaceDocumentState | null {
	const persisted = readPersistedRecord(storage, now);
	if (!persisted) return null;

	const saved = persisted.conversation;
	if (saved?.incognito && saved.conversationId === conversationId) {
		// The whole panel was the deleted incognito chat's, library opens included.
		storage?.removeItem(CHAT_WORKSPACE_STATE_STORAGE_KEY);
		return null;
	}

	const next = reduceWorkspaceDocumentsForDeletedConversation(
		persisted.documents,
		conversationId,
		persisted.activeDocumentId,
	);
	const presentation = next.isOpen ? persisted.presentation : "docked";

	writePersistedRecord(
		storage,
		{
			...next,
			presentation,
			conversation: saved,
		},
		now,
	);

	return next.documents.length > 0
		? {
				...next,
				presentation,
				updatedAt: now,
				conversation: saved,
			}
		: null;
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
