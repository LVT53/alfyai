import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	verifyServiceAssertion: vi.fn(),
}));

vi.mock("$lib/server/db", () => ({
	db: {
		query: {
			conversations: {
				findFirst: vi.fn(),
			},
		},
	},
}));

vi.mock("$lib/server/services/web-research", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/server/services/web-research")>();
	return {
		...actual,
		researchWeb: vi.fn(),
	};
});

import { verifyServiceAssertion } from "$lib/server/auth/hooks";
import { db } from "$lib/server/db";
import { researchWeb } from "$lib/server/services/web-research";
import { POST } from "./+server";

const mockVerifyServiceAssertion = verifyServiceAssertion as ReturnType<
	typeof vi.fn
>;
const mockResearchWeb = researchWeb as ReturnType<typeof vi.fn>;
const mockFindConversation = db.query.conversations.findFirst as ReturnType<
	typeof vi.fn
>;
type ResearchWebEvent = Parameters<typeof POST>[0];

function makeEvent(
	body: unknown,
	user: { id: string; email?: string } | null = {
		id: "user-1",
		email: "test@example.com",
	},
	authorization?: string,
) {
	return {
		request: new Request("http://localhost/api/tools/research-web", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(authorization ? { Authorization: authorization } : {}),
			},
			body: JSON.stringify(body),
		}),
		locals: { user },
		params: {},
		url: new URL("http://localhost/api/tools/research-web"),
		route: { id: "/api/tools/research-web" },
	} as unknown as ResearchWebEvent;
}

describe("POST /api/tools/research-web", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockResearchWeb.mockResolvedValue({
			query: "current price",
			queries: [],
			sources: [],
			evidence: [],
			diagnostics: {
				mode: "exact",
				freshness: "live",
				sourcePolicy: "commerce",
				providers: {
					exaConfigured: true,
					braveConfigured: true,
				},
				plannedQueryCount: 0,
				directUrlCount: 0,
				fetchedSourceCount: 0,
				fusedSourceCount: 0,
				selectedSourceCount: 0,
				providerCalls: [],
				contentCharBudget: 12000,
				openedPageCount: 0,
				sourceReranked: false,
				evidenceCandidateCount: 0,
				exactEvidenceCandidateCount: 0,
				reranked: false,
				youtubeTranscriptCandidateCount: 0,
				youtubeTranscriptFetchedCount: 0,
				youtubeTranscriptFailedCount: 0,
				youtubeTranscriptErrors: [],
				fallbackReasons: [],
			},
		});
		mockVerifyServiceAssertion.mockReturnValue({
			valid: true,
			claims: {
				conversationId: "conv-1",
				userId: "user-1",
				exp: Date.now() + 60_000,
			},
		});
		mockFindConversation.mockResolvedValue({ id: "conv-1", userId: "user-1" });
	});

	it("runs web research for an authenticated request", async () => {
		const response = await POST(
			makeEvent({
				query: " current price ",
				mode: "exact",
				freshness: "live",
				source_policy: "commerce",
				max_sources: 5,
				quote_required: true,
				conversationId: "conv-1",
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.query).toBe("current price");
		expect(mockResearchWeb).toHaveBeenCalledWith({
			query: "current price",
			mode: "exact",
			freshness: "live",
			sourcePolicy: "commerce",
			maxSources: 5,
			quoteRequired: true,
		});
	});

	it("accepts a valid signed service assertion when no browser session exists", async () => {
		const response = await POST(
			makeEvent(
				{ query: "docs", conversationId: "conv-1" },
				null,
				"Bearer signed",
			),
		);

		expect(response.status).toBe(200);
		expect(mockVerifyServiceAssertion).toHaveBeenCalledWith(
			"Bearer signed",
		);
	});

	it("rejects invalid enum values before provider calls", async () => {
		const response = await POST(makeEvent({ query: "docs", mode: "deep" }));
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.error).toMatch(/mode is invalid/);
		expect(mockResearchWeb).not.toHaveBeenCalled();
	});

	it("rejects conversation IDs from another user", async () => {
		mockFindConversation.mockResolvedValue({ id: "conv-2", userId: "user-2" });

		const response = await POST(
			makeEvent({ query: "docs", conversationId: "conv-2" }),
		);

		expect(response.status).toBe(401);
		expect(mockResearchWeb).not.toHaveBeenCalled();
	});
});
