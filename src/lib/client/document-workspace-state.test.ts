import { describe, expect, it } from "vitest";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import {
	discardPersistedWorkspaceDocumentStateOfIncognitoConversation,
	loadPersistedWorkspaceDocumentState,
	reduceWorkspaceClose,
	reduceWorkspaceDocumentClose,
	reduceWorkspaceDocumentOpen,
	reduceWorkspaceDocumentsForDeletedConversation,
	removeConversationFromPersistedWorkspaceDocumentState,
	savePersistedWorkspaceDocumentState,
	type WorkspaceConversation,
} from "./document-workspace-state";

// The chat whose panel a test saves from and restores into, unless it says otherwise.
const CHAT_A: WorkspaceConversation = {
	conversationId: "chat-a",
	incognito: false,
};

function makeDocument(id: string, title = id): DocumentWorkspaceItem {
	return {
		id,
		source: "knowledge_artifact",
		filename: `${id}.md`,
		title,
		mimeType: "text/markdown",
		artifactId: id,
	};
}

describe("document workspace state", () => {
	it("opens a working document and selects it without duplicating an already-open document", () => {
		const first = makeDocument("doc-1", "Draft");
		const opened = reduceWorkspaceDocumentOpen([], first);

		expect(opened).toMatchObject({
			documents: [first],
			activeDocumentId: "doc-1",
			isOpen: true,
		});

		const refreshed = reduceWorkspaceDocumentOpen(opened.documents, {
			...first,
			title: "Updated draft",
		});

		expect(refreshed.documents).toHaveLength(1);
		expect(refreshed.documents[0].title).toBe("Updated draft");
		expect(refreshed.activeDocumentId).toBe("doc-1");
	});

	it("closes the active working document and falls back to the last remaining document", () => {
		const documents = [
			makeDocument("doc-1"),
			makeDocument("doc-2"),
			makeDocument("doc-3"),
		];

		const result = reduceWorkspaceDocumentClose(documents, "doc-3", "doc-3");

		expect(result.documents.map((document) => document.id)).toEqual([
			"doc-1",
			"doc-2",
		]);
		expect(result.activeDocumentId).toBe("doc-2");
		expect(result.isOpen).toBe(true);
	});

	it("removes the last open document when the workspace is closed", () => {
		const result = reduceWorkspaceClose([makeDocument("doc-1")], "doc-1");

		expect(result).toEqual({
			documents: [],
			activeDocumentId: null,
			isOpen: false,
		});
	});

	it("hides a multi-document workspace without dropping the open document list", () => {
		const documents = [makeDocument("doc-1"), makeDocument("doc-2")];
		const result = reduceWorkspaceClose(documents, "doc-1");

		expect(result).toEqual({
			documents,
			activeDocumentId: "doc-1",
			isOpen: false,
		});
	});

	it("persists an open workspace so chat navigation can restore the same rail", () => {
		const storage = new Map<string, string>();
		const storageAdapter = {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		};
		const documents = [makeDocument("doc-1"), makeDocument("doc-2")];

		savePersistedWorkspaceDocumentState(storageAdapter, {
			documents,
			activeDocumentId: "doc-2",
			isOpen: true,
			presentation: "expanded",
			conversation: CHAT_A,
		});

		expect(
			loadPersistedWorkspaceDocumentState(storageAdapter, CHAT_A),
		).toMatchObject({
			documents,
			activeDocumentId: "doc-2",
			isOpen: true,
			presentation: "expanded",
		});
	});

	it("drops empty or stale persisted workspace state", () => {
		const storage = new Map<string, string>();
		const storageAdapter = {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		};

		savePersistedWorkspaceDocumentState(
			storageAdapter,
			{
				documents: [makeDocument("doc-1")],
				activeDocumentId: "doc-1",
				isOpen: true,
				presentation: "docked",
				conversation: CHAT_A,
			},
			1000,
		);

		expect(
			loadPersistedWorkspaceDocumentState(
				storageAdapter,
				CHAT_A,
				1000 + 8 * 24 * 60 * 60 * 1000,
			),
		).toBeNull();

		savePersistedWorkspaceDocumentState(storageAdapter, {
			documents: [],
			activeDocumentId: null,
			isOpen: false,
			presentation: "docked",
			conversation: CHAT_A,
		});

		expect(
			loadPersistedWorkspaceDocumentState(storageAdapter, CHAT_A),
		).toBeNull();
	});

	it("removes documents owned by a deleted conversation and keeps the remaining active document valid", () => {
		const documents = [
			{
				...makeDocument("file-1"),
				conversationId: "deleted-conversation",
			},
			{
				...makeDocument("file-2"),
				originConversationId: "deleted-conversation",
			},
			{
				...makeDocument("file-3"),
				conversationId: "kept-conversation",
			},
		];

		const result = reduceWorkspaceDocumentsForDeletedConversation(
			documents,
			"deleted-conversation",
			"file-2",
		);

		expect(result.documents.map((document) => document.id)).toEqual(["file-3"]);
		expect(result.activeDocumentId).toBe("file-3");
		expect(result.isOpen).toBe(true);
	});

	it("purges deleted-conversation documents from persisted workspace state", () => {
		const storage = new Map<string, string>();
		const storageAdapter = {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		};

		savePersistedWorkspaceDocumentState(storageAdapter, {
			documents: [
				{ ...makeDocument("file-1"), conversationId: "deleted-conversation" },
			],
			activeDocumentId: "file-1",
			isOpen: true,
			presentation: "expanded",
			conversation: CHAT_A,
		});

		expect(
			removeConversationFromPersistedWorkspaceDocumentState(
				storageAdapter,
				"deleted-conversation",
			),
		).toBeNull();
		expect(
			loadPersistedWorkspaceDocumentState(storageAdapter, CHAT_A),
		).toBeNull();
	});
});

// A chat's panel after a reload. The tab's storage is shared by every chat it
// visits, so what a chat restores has to be decided by who is asking: the panel
// is "what this chat made", and an incognito chat's panel is never anyone
// else's.
describe("restoring a chat's panel", () => {
	const CHAT_B: WorkspaceConversation = {
		conversationId: "chat-b",
		incognito: false,
	};
	const INCOGNITO_I: WorkspaceConversation = {
		conversationId: "chat-i",
		incognito: true,
	};
	const INCOGNITO_J: WorkspaceConversation = {
		conversationId: "chat-j",
		incognito: true,
	};
	// The storage key is part of the persisted format: a legacy record is written
	// under it by hand.
	const STORAGE_KEY = "alfyai-chat-document-workspace";

	function memoryStorage() {
		const values = new Map<string, string>();
		return {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => {
				values.set(key, value);
			},
			removeItem: (key: string) => {
				values.delete(key);
			},
			isEmpty: () => values.size === 0,
		};
	}

	function madeIn(id: string, conversationId: string): DocumentWorkspaceItem {
		return { ...makeDocument(id), conversationId };
	}

	function savePanel(
		storage: ReturnType<typeof memoryStorage>,
		conversation: WorkspaceConversation,
		documents: DocumentWorkspaceItem[],
		activeDocumentId: string | null = documents.at(-1)?.id ?? null,
		presentation: "docked" | "expanded" = "docked",
	) {
		savePersistedWorkspaceDocumentState(storage, {
			documents,
			activeDocumentId,
			isOpen: true,
			presentation,
			conversation,
		});
	}

	it("gives a chat back its own panel whole, including an item its parent made", () => {
		const storage = memoryStorage();
		savePanel(
			storage,
			CHAT_A,
			[madeIn("own", "chat-a"), madeIn("from-the-parent", "the-parent")],
			"from-the-parent",
			"expanded",
		);

		const restored = loadPersistedWorkspaceDocumentState(storage, CHAT_A);

		expect(restored?.documents.map((entry) => entry.id)).toEqual([
			"own",
			"from-the-parent",
		]);
		expect(restored).toMatchObject({
			activeDocumentId: "from-the-parent",
			isOpen: true,
			presentation: "expanded",
		});
	});

	it("does not open another chat's items in this chat (normal to normal)", () => {
		const storage = memoryStorage();
		savePanel(storage, CHAT_A, [
			madeIn("made-in-a", "chat-a"),
			{ ...makeDocument("file-from-a"), originConversationId: "chat-a" },
		]);

		expect(loadPersistedWorkspaceDocumentState(storage, CHAT_B)).toBeNull();
	});

	it("keeps what belongs to this chat and drops what belongs to another, without opening the panel on a stranger", () => {
		const storage = memoryStorage();
		savePanel(
			storage,
			CHAT_A,
			[
				madeIn("a-1", "chat-a"),
				madeIn("b-1", "chat-b"),
				madeIn("a-2", "chat-a"),
			],
			"a-1",
			"expanded",
		);

		const restored = loadPersistedWorkspaceDocumentState(storage, CHAT_B);

		expect(restored?.documents.map((entry) => entry.id)).toEqual(["b-1"]);
		expect(restored).toMatchObject({
			activeDocumentId: "b-1",
			// The item that was on screen was chat A's: chat B's panel does not open
			// on something else, and does not stay expanded.
			isOpen: false,
			presentation: "docked",
		});
	});

	it("carries the library and search opens that belong to no chat", () => {
		const storage = memoryStorage();
		const libraryOpen = makeDocument("library-open");
		savePanel(
			storage,
			CHAT_A,
			[madeIn("made-in-a", "chat-a"), libraryOpen],
			"library-open",
			"expanded",
		);

		const restored = loadPersistedWorkspaceDocumentState(storage, CHAT_B);

		expect(restored?.documents).toEqual([libraryOpen]);
		expect(restored).toMatchObject({
			activeDocumentId: "library-open",
			isOpen: true,
			presentation: "expanded",
		});
	});

	it("never restores an incognito chat's items into another chat, and leaves nothing of them in storage", () => {
		const storage = memoryStorage();
		savePanel(storage, INCOGNITO_I, [
			madeIn("made-in-i", "chat-i"),
			// Opened while the incognito chat was on screen, but linked to no chat:
			// it is still that chat's, and no other chat inherits it.
			makeDocument("library-open-in-i"),
		]);

		expect(loadPersistedWorkspaceDocumentState(storage, CHAT_B)).toBeNull();
		expect(storage.isEmpty()).toBe(true);
	});

	it("gives an incognito chat its own panel back when it is reloaded", () => {
		const storage = memoryStorage();
		const libraryOpen = makeDocument("library-open-in-i");
		savePanel(storage, INCOGNITO_I, [
			madeIn("made-in-i", "chat-i"),
			libraryOpen,
		]);

		const restored = loadPersistedWorkspaceDocumentState(storage, INCOGNITO_I);

		expect(restored?.documents.map((entry) => entry.id)).toEqual([
			"made-in-i",
			"library-open-in-i",
		]);
		expect(restored?.isOpen).toBe(true);
	});

	it("does not carry a normal chat's panel into an incognito chat either", () => {
		const storage = memoryStorage();
		savePanel(storage, CHAT_A, [
			madeIn("made-in-a", "chat-a"),
			makeDocument("library-open"),
		]);

		expect(
			loadPersistedWorkspaceDocumentState(storage, INCOGNITO_I),
		).toBeNull();
	});

	it("reads a record written before the conversation was recorded as unknown: only this chat's own items", () => {
		const storage = memoryStorage();
		storage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				documents: [
					madeIn("made-in-a", "chat-a"),
					makeDocument("library-open"),
				],
				activeDocumentId: "made-in-a",
				isOpen: true,
				presentation: "docked",
				updatedAt: Date.now(),
			}),
		);

		const forA = loadPersistedWorkspaceDocumentState(storage, CHAT_A);
		expect(forA?.documents.map((entry) => entry.id)).toEqual(["made-in-a"]);
		expect(loadPersistedWorkspaceDocumentState(storage, CHAT_B)).toBeNull();
	});

	it("discards an incognito chat's stored panel when the chat is left, and nothing else", () => {
		const storage = memoryStorage();
		savePanel(storage, INCOGNITO_I, [madeIn("made-in-i", "chat-i")]);
		discardPersistedWorkspaceDocumentStateOfIncognitoConversation(
			storage,
			"chat-i",
		);
		expect(storage.isEmpty()).toBe(true);

		// A normal chat's panel is kept for its reload: leaving it discards nothing.
		savePanel(storage, CHAT_A, [madeIn("made-in-a", "chat-a")]);
		discardPersistedWorkspaceDocumentStateOfIncognitoConversation(
			storage,
			"chat-a",
		);
		expect(loadPersistedWorkspaceDocumentState(storage, CHAT_A)).not.toBeNull();

		// Nor does one incognito chat's leaving take another's panel with it.
		savePanel(storage, INCOGNITO_J, [madeIn("made-in-j", "chat-j")]);
		discardPersistedWorkspaceDocumentStateOfIncognitoConversation(
			storage,
			"chat-i",
		);
		expect(
			loadPersistedWorkspaceDocumentState(storage, INCOGNITO_J),
		).not.toBeNull();
	});

	it("keeps whose panel it is when a deleted chat's items are removed, and drops a deleted incognito chat's panel whole", () => {
		const storage = memoryStorage();
		savePanel(storage, CHAT_A, [
			madeIn("made-in-a", "chat-a"),
			madeIn("made-in-b", "chat-b"),
		]);
		removeConversationFromPersistedWorkspaceDocumentState(storage, "chat-b");
		expect(
			loadPersistedWorkspaceDocumentState(storage, CHAT_A)?.documents.map(
				(entry) => entry.id,
			),
		).toEqual(["made-in-a"]);
		// Still chat A's: another chat still cannot pick it up.
		expect(loadPersistedWorkspaceDocumentState(storage, CHAT_B)).toBeNull();

		savePanel(storage, INCOGNITO_I, [
			madeIn("made-in-i", "chat-i"),
			makeDocument("library-open-in-i"),
		]);
		removeConversationFromPersistedWorkspaceDocumentState(storage, "chat-i");
		// Nothing of the incognito chat is left in the tab. (The storage as a whole
		// is not empty: chat A's panel is remembered beside it now, and is its own
		// business, see "each chat remembers its own panel" below.)
		const stored = storage.getItem(STORAGE_KEY) ?? "";
		expect(stored).not.toContain("chat-i");
		expect(stored).not.toContain("made-in-i");
		expect(stored).not.toContain("library-open-in-i");
		expect(
			loadPersistedWorkspaceDocumentState(storage, CHAT_A)?.documents.map(
				(entry) => entry.id,
			),
		).toEqual(["made-in-a"]);
	});
});

// Each chat remembers its own panel. The tab keeps one stored panel PER chat
// (the last few it visited), so going to chat B and back to chat A gives A its
// panel again, while every rule above about what may cross from one chat to
// another still holds.
describe("each chat remembers its own panel", () => {
	const CHAT_B: WorkspaceConversation = {
		conversationId: "chat-b",
		incognito: false,
	};
	const INCOGNITO_I: WorkspaceConversation = {
		conversationId: "chat-i",
		incognito: true,
	};
	// The storage key and the value's shape are part of the persisted format: a
	// value written by the previous build is put there by hand, and the newest
	// panel stays at the value's top level, where the e2e suite reads it.
	const STORAGE_KEY = "alfyai-chat-document-workspace";
	const DAY = 24 * 60 * 60 * 1000;

	function memoryStorage() {
		const values = new Map<string, string>();
		return {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => {
				values.set(key, value);
			},
			removeItem: (key: string) => {
				values.delete(key);
			},
			isEmpty: () => values.size === 0,
		};
	}
	type Storage = ReturnType<typeof memoryStorage>;

	function madeIn(id: string, conversationId: string): DocumentWorkspaceItem {
		return { ...makeDocument(id), conversationId };
	}

	function savePanel(
		storage: Storage,
		conversation: WorkspaceConversation,
		documents: DocumentWorkspaceItem[],
		options: {
			activeDocumentId?: string | null;
			presentation?: "docked" | "expanded";
			now?: number;
		} = {},
	) {
		savePersistedWorkspaceDocumentState(
			storage,
			{
				documents,
				activeDocumentId:
					options.activeDocumentId === undefined
						? (documents.at(-1)?.id ?? null)
						: options.activeDocumentId,
				isOpen: documents.length > 0,
				presentation: options.presentation ?? "docked",
				conversation,
			},
			options.now,
		);
	}

	function idsFor(
		storage: Storage,
		conversation: WorkspaceConversation,
		now?: number,
	): string[] | null {
		return (
			loadPersistedWorkspaceDocumentState(
				storage,
				conversation,
				now,
			)?.documents.map((entry) => entry.id) ?? null
		);
	}

	function chatOf(index: number): WorkspaceConversation {
		return { conversationId: `chat-${index}`, incognito: false };
	}

	it("gives chat A its own panel back after the tab visited chat B", () => {
		const storage = memoryStorage();
		savePanel(
			storage,
			CHAT_A,
			[madeIn("a-1", "chat-a"), madeIn("a-2", "chat-a")],
			{ activeDocumentId: "a-1", presentation: "expanded" },
		);
		savePanel(storage, CHAT_B, [madeIn("b-1", "chat-b")]);

		const restoredA = loadPersistedWorkspaceDocumentState(storage, CHAT_A);
		expect(restoredA?.documents.map((entry) => entry.id)).toEqual([
			"a-1",
			"a-2",
		]);
		expect(restoredA).toMatchObject({
			activeDocumentId: "a-1",
			isOpen: true,
			presentation: "expanded",
		});
		expect(idsFor(storage, CHAT_B)).toEqual(["b-1"]);
	});

	it("keeps a chat's panel when another chat is visited with nothing open", () => {
		const storage = memoryStorage();
		savePanel(storage, CHAT_A, [madeIn("a-1", "chat-a")]);
		savePanel(storage, CHAT_B, []);

		expect(idsFor(storage, CHAT_A)).toEqual(["a-1"]);
		expect(idsFor(storage, CHAT_B)).toBeNull();
	});

	it("remembers the last 20 chats and lets the oldest go", () => {
		const storage = memoryStorage();
		for (let index = 1; index <= 25; index += 1) {
			savePanel(storage, chatOf(index), [
				madeIn(`doc-${index}`, `chat-${index}`),
			]);
		}

		for (let index = 1; index <= 5; index += 1) {
			expect(idsFor(storage, chatOf(index)), `chat ${index}`).toBeNull();
		}
		for (let index = 6; index <= 25; index += 1) {
			expect(idsFor(storage, chatOf(index)), `chat ${index}`).toEqual([
				`doc-${index}`,
			]);
		}
	});

	it("counts a chat that is visited again as the newest, so the chat nobody came back to goes first", () => {
		const storage = memoryStorage();
		for (let index = 1; index <= 20; index += 1) {
			savePanel(storage, chatOf(index), [
				madeIn(`doc-${index}`, `chat-${index}`),
			]);
		}
		savePanel(storage, chatOf(1), [madeIn("doc-1", "chat-1")]);
		savePanel(storage, chatOf(21), [madeIn("doc-21", "chat-21")]);

		expect(idsFor(storage, chatOf(2))).toBeNull();
		expect(idsFor(storage, chatOf(1))).toEqual(["doc-1"]);
		expect(idsFor(storage, chatOf(21))).toEqual(["doc-21"]);
	});

	it("forgets a panel that was last saved more than a week ago and keeps the others", () => {
		const storage = memoryStorage();
		savePanel(storage, CHAT_A, [madeIn("a-1", "chat-a")], { now: 1000 });
		savePanel(storage, CHAT_B, [madeIn("b-1", "chat-b")], {
			now: 1000 + 6 * DAY,
		});

		expect(idsFor(storage, CHAT_A, 1000 + 8 * DAY)).toBeNull();
		expect(idsFor(storage, CHAT_B, 1000 + 8 * DAY)).toEqual(["b-1"]);
	});

	it("gives a chat that has a panel of its own only that panel, not the library opens of the chat visited last", () => {
		const storage = memoryStorage();
		savePanel(storage, CHAT_B, [madeIn("b-1", "chat-b")]);
		savePanel(storage, CHAT_A, [
			madeIn("a-1", "chat-a"),
			makeDocument("library-open"),
		]);

		expect(idsFor(storage, CHAT_B)).toEqual(["b-1"]);
		// A chat with none of its own still gets what belongs to no chat.
		expect(idsFor(storage, chatOf(3))).toEqual(["library-open"]);
	});

	it("does not bring back in a new chat what was closed in the chat visited last", () => {
		const storage = memoryStorage();
		const libraryOpen = makeDocument("library-open");
		savePanel(storage, CHAT_A, [libraryOpen]);
		// Chat B is given it, and closes it.
		expect(idsFor(storage, CHAT_B)).toEqual(["library-open"]);
		savePanel(storage, CHAT_B, [libraryOpen]);
		savePanel(storage, CHAT_B, []);

		// Chat A still remembers it for itself, but a chat that has none of its
		// own does not pick it up from A behind B's back.
		expect(idsFor(storage, chatOf(3))).toBeNull();
		expect(idsFor(storage, CHAT_A)).toEqual(["library-open"]);
	});

	describe("an incognito chat", () => {
		it("is never restored in another chat, is taken out of the tab when another chat asks, and leaves the normal chats' panels alone", () => {
			const storage = memoryStorage();
			savePanel(storage, CHAT_A, [madeIn("a-1", "chat-a")]);
			savePanel(storage, INCOGNITO_I, [
				madeIn("made-in-i", "chat-i"),
				makeDocument("library-open-in-i"),
			]);

			expect(idsFor(storage, CHAT_B)).toBeNull();
			const stored = storage.getItem(STORAGE_KEY) ?? "";
			expect(stored).not.toContain("made-in-i");
			expect(stored).not.toContain("library-open-in-i");
			expect(stored).not.toContain("chat-i");
			expect(idsFor(storage, CHAT_A)).toEqual(["a-1"]);
		});

		it("gets its own panel back when it is reloaded, and a normal chat's panel is still there for that chat afterwards", () => {
			const storage = memoryStorage();
			savePanel(storage, CHAT_A, [madeIn("a-1", "chat-a")]);
			savePanel(storage, INCOGNITO_I, [madeIn("made-in-i", "chat-i")]);

			expect(idsFor(storage, INCOGNITO_I)).toEqual(["made-in-i"]);
			expect(idsFor(storage, CHAT_A)).toEqual(["a-1"]);
			expect(storage.getItem(STORAGE_KEY)).not.toContain("made-in-i");
		});

		it("is discarded alone when the chat is left", () => {
			const storage = memoryStorage();
			savePanel(storage, CHAT_A, [madeIn("a-1", "chat-a")]);
			savePanel(storage, INCOGNITO_I, [madeIn("made-in-i", "chat-i")]);

			discardPersistedWorkspaceDocumentStateOfIncognitoConversation(
				storage,
				"chat-i",
			);

			expect(storage.getItem(STORAGE_KEY)).not.toContain("chat-i");
			expect(idsFor(storage, CHAT_A)).toEqual(["a-1"]);
		});

		it("is dropped whole, library opens included, when the chat is deleted, and the normal chats' panels stay", () => {
			const storage = memoryStorage();
			savePanel(storage, CHAT_A, [madeIn("a-1", "chat-a")]);
			savePanel(storage, INCOGNITO_I, [
				madeIn("made-in-i", "chat-i"),
				makeDocument("library-open-in-i"),
			]);

			removeConversationFromPersistedWorkspaceDocumentState(storage, "chat-i");

			const stored = storage.getItem(STORAGE_KEY) ?? "";
			expect(stored).not.toContain("made-in-i");
			expect(stored).not.toContain("library-open-in-i");
			expect(idsFor(storage, CHAT_A)).toEqual(["a-1"]);
		});

		it("is not kept when another chat's panel is saved beside it", () => {
			const storage = memoryStorage();
			savePanel(storage, INCOGNITO_I, [madeIn("made-in-i", "chat-i")]);
			savePanel(storage, CHAT_B, [madeIn("b-1", "chat-b")]);

			expect(storage.getItem(STORAGE_KEY)).not.toContain("made-in-i");
			expect(idsFor(storage, CHAT_B)).toEqual(["b-1"]);
		});
	});

	describe("a stored value that was written by the previous build, or is not one at all", () => {
		function legacyValue(overrides: Record<string, unknown> = {}) {
			return JSON.stringify({
				documents: [madeIn("a-1", "chat-a"), makeDocument("library-open")],
				activeDocumentId: "a-1",
				isOpen: true,
				presentation: "expanded",
				updatedAt: Date.now(),
				conversation: CHAT_A,
				...overrides,
			});
		}

		it("reads one stored panel as that chat's panel, and keeps it when another chat saves its own", () => {
			const storage = memoryStorage();
			storage.setItem(STORAGE_KEY, legacyValue());

			expect(idsFor(storage, CHAT_A)).toEqual(["a-1", "library-open"]);
			expect(idsFor(storage, CHAT_B)).toEqual(["library-open"]);

			savePanel(storage, CHAT_B, [madeIn("b-1", "chat-b")]);
			expect(idsFor(storage, CHAT_A)).toEqual(["a-1", "library-open"]);
			expect(idsFor(storage, CHAT_B)).toEqual(["b-1"]);
		});

		it("drops a stored panel that does not say whose it is once another panel is saved", () => {
			const storage = memoryStorage();
			storage.setItem(STORAGE_KEY, legacyValue({ conversation: undefined }));

			expect(idsFor(storage, CHAT_A)).toEqual(["a-1"]);
			savePanel(storage, CHAT_B, [madeIn("b-1", "chat-b")]);

			expect(idsFor(storage, CHAT_A)).toBeNull();
			expect(idsFor(storage, CHAT_B)).toEqual(["b-1"]);
		});

		it.each([
			["text that is not JSON", "not json {"],
			["JSON that is not a panel", "[1, 2, 3]"],
			["a panel whose documents are not a list", '{"documents": "x"}'],
			["a null", "null"],
		])("reads %s as nothing, without throwing", (_name, value) => {
			const storage = memoryStorage();
			storage.setItem(STORAGE_KEY, value);

			expect(idsFor(storage, CHAT_A)).toBeNull();
			// And the next save simply replaces it.
			savePanel(storage, CHAT_A, [madeIn("a-1", "chat-a")]);
			expect(idsFor(storage, CHAT_A)).toEqual(["a-1"]);
		});

		it("ignores stored panels of the other chats that are not panels, and still restores the newest", () => {
			const storage = memoryStorage();
			storage.setItem(
				STORAGE_KEY,
				legacyValue({ others: [null, 5, "x", { documents: "y" }, {}] }),
			);
			expect(idsFor(storage, CHAT_A)).toEqual(["a-1", "library-open"]);

			storage.setItem(STORAGE_KEY, legacyValue({ others: "not a list" }));
			expect(idsFor(storage, CHAT_A)).toEqual(["a-1", "library-open"]);
		});
	});

	it("keeps the newest panel at the top level of the stored value, and the panels of the chats before it under `others`", () => {
		const storage = memoryStorage();
		savePanel(storage, CHAT_A, [madeIn("a-1", "chat-a")]);
		savePanel(storage, CHAT_B, [madeIn("b-1", "chat-b")]);

		const stored = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
		expect(stored.documents.map((entry: { id: string }) => entry.id)).toEqual([
			"b-1",
		]);
		expect(stored.conversation).toEqual(CHAT_B);
		expect(
			stored.others.map(
				(entry: { conversation: WorkspaceConversation }) =>
					entry.conversation.conversationId,
			),
		).toEqual(["chat-a"]);
	});
});
