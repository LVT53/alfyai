import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Cookies, RequestEvent } from "@sveltejs/kit";
import { afterEach, beforeEach, vi } from "vitest";
import type { SessionUser } from "$lib/server/services/auth-types";
import type { KnowledgeUploadResponse } from "$lib/server/services/knowledge/types";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";

/**
 * The ledger row every upload response now carries. Phase 3: the request ends
 * when the bytes are stored, so `queued` is the ordinary answer.
 */
export function makeExtractionJobDTO(
	overrides: Partial<DocumentExtractionJobDTO> = {},
): DocumentExtractionJobDTO {
	return {
		id: "extraction-job-1",
		sourceArtifactId: "artifact-1",
		normalizedArtifactId: null,
		status: "queued",
		intakeRoute: "mineru",
		fileName: "scan.pdf",
		attemptCount: 0,
		maxAttempts: 3,
		retryable: false,
		cancelable: true,
		error: null,
		createdAt: 1_777_140_000_000,
		updatedAt: 1_777_140_000_000,
		startedAt: null,
		legacy: false,
		...overrides,
	};
}

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/attachment-trace", () => ({
	createAttachmentTraceId: vi.fn(() => "trace-upload"),
	logAttachmentTrace: vi.fn(),
}));

vi.mock("$lib/server/services/knowledge/upload-intake", () => ({
	completeKnowledgeUploadFromStoredFile: vi.fn(),
	isKnowledgeUploadConversationError: vi.fn(() => false),
	resolveKnowledgeUploadLimits: vi.fn(() => ({
		maxFileUploadSize: 100 * 1024 * 1024,
		adapterBodySizeLimit: 100 * 1024 * 1024,
		multipartBodyLimit: 100 * 1024 * 1024,
		storedFileLimit: 100 * 1024 * 1024,
		chunkFileLimit: 100 * 1024 * 1024,
		chunkBodyLimit: 1024 * 1024,
		multipartOverheadAllowance: 1024 * 1024,
	})),
	validateKnowledgeUploadConversation: vi.fn(
		async (params: { conversationId?: string | null }) =>
			params.conversationId?.trim() || null,
	),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	completeKnowledgeUploadFromStoredFile,
	isKnowledgeUploadConversationError,
	validateKnowledgeUploadConversation,
} from "$lib/server/services/knowledge/upload-intake";

const defaultCompleteKnowledgeUploadResponse = {
	artifact: {
		id: "artifact-1",
		type: "source_document",
		retrievalClass: "durable",
		name: "scan.pdf",
		mimeType: "application/pdf",
		sizeBytes: 5,
		conversationId: "conv-1",
		summary: "scan.pdf",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	},
	normalizedArtifact: null,
	reusedExistingArtifact: false,
	promptReady: true,
	extraction: makeExtractionJobDTO(),
} satisfies KnowledgeUploadResponse;

const mockRequireAuth = vi.mocked(requireAuth);
export const mockCompleteKnowledgeUploadFromStoredFile = vi.mocked(
	completeKnowledgeUploadFromStoredFile,
);
export const mockIsKnowledgeUploadConversationError = vi.mocked(
	isKnowledgeUploadConversationError,
);
export const mockValidateKnowledgeUploadConversation = vi.mocked(
	validateKnowledgeUploadConversation,
);

type KnowledgeUploadRouteEvent<RouteId extends string = string> = RequestEvent<
	Record<string, never>,
	RouteId
>;

const noopCookies: Cookies = {
	get: () => undefined,
	getAll: () => [],
	set: () => undefined,
	delete: () => undefined,
	serialize: () => "",
};

function makeKnowledgeUploadRouteEvent<RouteId extends string>(params: {
	request: Request;
	requestUrl: string;
	routeId: RouteId;
	userId: string;
	email?: string;
	displayName?: string;
}): KnowledgeUploadRouteEvent<RouteId> {
	const user = {
		id: params.userId,
		email: params.email ?? "test@example.com",
		displayName: params.displayName ?? "Test User",
		role: "user",
		profilePicture: null,
		titleLanguage: "auto",
		uiLanguage: "en",
	} satisfies SessionUser;

	const event = {
		cookies: noopCookies,
		fetch: globalThis.fetch,
		getClientAddress: () => "127.0.0.1",
		locals: { user },
		params: {},
		platform: undefined,
		request: params.request,
		route: { id: params.routeId },
		setHeaders: () => undefined,
		url: new URL(params.requestUrl),
		isDataRequest: false,
		isSubRequest: false,
		isRemoteRequest: false,
		tracing: {
			enabled: false,
			root: undefined as never,
			current: undefined as never,
		},
	} satisfies KnowledgeUploadRouteEvent<RouteId>;

	return event;
}

export function makeKnowledgeUploadHeaders(
	overrides: Record<string, string> = {},
) {
	return {
		"content-type": "application/pdf",
		"x-alfyai-upload-name": "scan.pdf",
		"x-alfyai-upload-size": "10",
		"x-alfyai-upload-trace-id": "upload-test",
		"x-alfyai-conversation-id": "conv-1",
		...overrides,
	};
}

export function makeKnowledgeUploadEvent<RouteId extends string>(params: {
	body: BodyInit;
	headers: Record<string, string>;
	requestUrl: string;
	routeId: RouteId;
	userId: string;
	email?: string;
	displayName?: string;
}): KnowledgeUploadRouteEvent<RouteId> {
	return makeKnowledgeUploadRouteEvent({
		request: new Request(params.requestUrl, {
			method: "POST",
			headers: params.headers,
			body: params.body,
			// Undici requires this for a streamed body, which is the only way to
			// simulate a connection that dies mid-upload.
			...(params.body instanceof ReadableStream ? { duplex: "half" } : {}),
		} as RequestInit),
		requestUrl: params.requestUrl,
		routeId: params.routeId,
		userId: params.userId,
		email: params.email,
		displayName: params.displayName,
	});
}

export function makeKnowledgeUploadRequestEvent<
	RouteId extends string,
>(params: {
	headers: Record<string, string>;
	requestUrl: string;
	routeId: RouteId;
	userId: string;
	email?: string;
	displayName?: string;
}): KnowledgeUploadRouteEvent<RouteId> {
	return makeKnowledgeUploadRouteEvent({
		request: new Request(params.requestUrl, {
			method: "POST",
			headers: params.headers,
		}),
		requestUrl: params.requestUrl,
		routeId: params.routeId,
		userId: params.userId,
		email: params.email,
		displayName: params.displayName,
	});
}

/**
 * A per-TEST upload user, and therefore a per-test `.incoming` directory.
 *
 * These suites drive the real route, which writes to
 * `data/knowledge/<userId>/.incoming` under `process.cwd()` — a directory
 * shared by every suite in the run and by every test in this file. With a
 * fixed id ("raw-user", "user-1") three things could put a stranger's file
 * into the listing a "leaves nothing behind" assertion reads:
 *
 *  - a partial write from an EARLIER test in this file whose unlink resolved
 *    after that test's `afterEach` had already swept the directory;
 *  - any other suite that happens to use the same literal user id — "user-1"
 *    is the most common test user in this repo;
 *  - the route's own `scheduleKnowledgeUploadTempSweep`, which is throttled
 *    once an hour PER PROCESS and walks the whole real knowledge root, so it
 *    couples every suite that runs in the same worker.
 *
 * A fresh uuid per test removes all three at once, without touching the
 * assertion — which is the point: "nothing left behind" is the property under
 * test, and a test that swept harder would stop testing it.
 */
export function createKnowledgeUploadRouteHarness(params: {
	/** Prefix only. The id itself is minted fresh for every test. */
	userId: string;
}) {
	const state = {
		userId: params.userId,
		consoleInfoSpy: null as ReturnType<typeof vi.spyOn> | null,
		consoleWarnSpy: null as ReturnType<typeof vi.spyOn> | null,
	};

	beforeEach(() => {
		state.userId = `${params.userId}-${randomUUID()}`;
		vi.clearAllMocks();
		state.consoleInfoSpy = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);
		state.consoleWarnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		mockRequireAuth.mockReturnValue(undefined);
		mockIsKnowledgeUploadConversationError.mockReturnValue(false);
		mockValidateKnowledgeUploadConversation.mockImplementation(
			async (candidate: { conversationId?: string | null }) =>
				candidate.conversationId?.trim() || null,
		);
		mockCompleteKnowledgeUploadFromStoredFile.mockResolvedValue(
			defaultCompleteKnowledgeUploadResponse,
		);
	});

	afterEach(async () => {
		state.consoleInfoSpy?.mockRestore();
		state.consoleWarnSpy?.mockRestore();
		state.consoleInfoSpy = null;
		state.consoleWarnSpy = null;
		// The whole user directory, not just `.incoming`: the id is unique to
		// this test, so nothing else can be under it.
		await rm(join(process.cwd(), "data", "knowledge", state.userId), {
			force: true,
			recursive: true,
		});
	});

	return state;
}
