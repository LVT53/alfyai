import { describe, expect, it } from "vitest";
import type { ChatMessage } from "$lib/server/services/messages-types";
import type { AskQuestionDto } from "$lib/shared/ask-user";
import {
	continuesRowAbove,
	mergeReplyEvidence,
	personMessageOfReply,
	placeReplySegments,
	replyEndIndex,
	replyFirstMessageId,
} from "./reply-segments";

const NOW = 1_700_000_000_000;

function row(
	id: string,
	role: "user" | "assistant",
	content: string,
	overrides: Partial<ChatMessage> = {},
): ChatMessage {
	return {
		id,
		renderKey: id,
		role,
		content,
		timestamp: NOW,
		...overrides,
	};
}

// The mockup's question (docs/plans/ask-me-first/mockups.html, section 1).
function asked(overrides: Partial<AskQuestionDto> = {}): AskQuestionDto {
	return {
		id: "q-1",
		conversationId: "conv-1",
		assistantMessageId: "a-1",
		toolCallId: "call-1",
		questions: [
			{
				question: "Which way should we take it?",
				options: [
					{ label: "A party at home", recommended: true },
					{ label: "Dinner out, just close family" },
				],
			},
		],
		status: "waiting",
		answer: null,
		createdAt: NOW,
		...overrides,
	};
}

const FIRST_WORDS =
	"The biggest fork is the shape of the day itself, so let's settle that first.";
const SECOND_WORDS =
	"A party at home it is. Here is the plan:\n\n- Invite everyone for 15:00";

describe("placeReplySegments", () => {
	it("places a reply of two segments: the first continued, the second continuing it with the reply's words to copy", () => {
		const question = asked({ status: "answered" });
		const places = placeReplySegments(
			[
				row("u-1", "user", "Plan dad's 60th"),
				row("a-1", "assistant", FIRST_WORDS),
				row("a-2", "assistant", SECOND_WORDS, { continuesMessageId: "a-1" }),
			],
			[question],
			null,
		);

		expect(places.get("a-1")).toEqual({
			firstMessageId: "a-1",
			continuesAbove: false,
			continuedBelow: true,
			question,
			copyText: null,
			userIntent: null,
			drawsSources: false,
			sources: null,
		});
		expect(places.get("a-2")).toEqual({
			firstMessageId: "a-1",
			continuesAbove: true,
			continuedBelow: false,
			question: null,
			copyText: `${FIRST_WORDS}\n\n${SECOND_WORDS}`,
			userIntent: null,
			drawsSources: true,
			sources: null,
		});
	});

	it("keeps a row continued while its question waits", () => {
		const messages = [
			row("u-1", "user", "Plan dad's 60th"),
			row("a-1", "assistant", FIRST_WORDS),
		];
		const continuedBelow = (status: AskQuestionDto["status"]) =>
			placeReplySegments(messages, [asked({ status })], null).get("a-1")
				?.continuedBelow;

		// The reply is not over while the person has the question or the answer is out...
		expect(continuedBelow("waiting")).toBe(true);
		expect(continuedBelow("answering")).toBe(true);
		// ...and is over once the question is settled and nothing carries on from it.
		expect(continuedBelow("answered")).toBe(false);
		expect(continuedBelow("closed")).toBe(false);
		// A row with no question of its own is a reply that ended.
		expect(
			placeReplySegments(messages, [], null).get("a-1")?.continuedBelow,
		).toBe(false);
	});

	it("keeps the last row of a longer reply continued while its own question waits", () => {
		const places = placeReplySegments(
			[
				row("u-1", "user", "Plan dad's 60th"),
				row("a-1", "assistant", FIRST_WORDS),
				row("a-2", "assistant", SECOND_WORDS, { continuesMessageId: "a-1" }),
			],
			[
				asked({ status: "answered" }),
				asked({
					id: "q-2",
					assistantMessageId: "a-2",
					toolCallId: "call-2",
					status: "waiting",
				}),
			],
			null,
		);

		expect(places.get("a-1")?.question?.id).toBe("q-1");
		expect(places.get("a-2")).toMatchObject({
			firstMessageId: "a-1",
			continuesAbove: true,
			continuedBelow: true,
			question: { id: "q-2" },
		});
	});

	it("starts a new reply when the continued row is not loaded", () => {
		const places = placeReplySegments(
			[
				row("u-2", "user", "And then?"),
				row("a-2", "assistant", SECOND_WORDS, {
					continuesMessageId: "a-1-not-loaded",
				}),
			],
			[],
			null,
		);

		expect(places.get("a-2")).toEqual({
			firstMessageId: "a-2",
			continuesAbove: false,
			continuedBelow: false,
			question: null,
			copyText: null,
			userIntent: null,
			drawsSources: true,
			sources: null,
		});
	});

	it("starts a new reply when the continued row is not the one right above", () => {
		const places = placeReplySegments(
			[
				row("u-1", "user", "Plan dad's 60th"),
				row("a-1", "assistant", FIRST_WORDS),
				row("u-2", "user", "Another thing"),
				row("a-3", "assistant", SECOND_WORDS, { continuesMessageId: "a-1" }),
			],
			[],
			null,
		);

		expect(places.get("a-1")).toMatchObject({
			continuedBelow: false,
			copyText: null,
		});
		expect(places.get("a-3")).toMatchObject({
			firstMessageId: "a-3",
			continuesAbove: false,
			copyText: null,
		});
	});

	it("starts a new reply when the row above is another reply's, whatever row the link names", () => {
		// Two replies one after the other. The second's link names the first reply's
		// row, which is loaded but is not the row right above it.
		const places = placeReplySegments(
			[
				row("u-1", "user", "Plan dad's 60th"),
				row("a-1", "assistant", "One."),
				row("a-2", "assistant", "Two.", { continuesMessageId: "a-1" }),
				row("a-3", "assistant", "Three.", { continuesMessageId: "a-1" }),
				row("a-4", "assistant", "Four.", {
					continuesMessageId: "a-gone",
				}),
			],
			[],
			null,
		);

		expect(places.get("a-2")).toMatchObject({
			firstMessageId: "a-1",
			continuesAbove: true,
		});
		expect(places.get("a-3")).toMatchObject({
			firstMessageId: "a-3",
			continuesAbove: false,
			continuedBelow: false,
			copyText: null,
		});
		expect(places.get("a-4")).toMatchObject({
			firstMessageId: "a-4",
			continuesAbove: false,
			copyText: null,
		});
		// The first reply is a-1 and a-2 only.
		expect(places.get("a-2")?.copyText).toBe("One.\n\nTwo.");
	});

	it("puts an unstamped question on the streaming row only", () => {
		const unstamped = asked({
			id: "q-live",
			assistantMessageId: null,
			createdAt: NOW + 4_000,
		});
		const messages = [
			row("u-1", "user", "Plan dad's 60th"),
			row("a-1", "assistant", "An earlier reply.", { timestamp: NOW - 60_000 }),
			row("u-2", "user", "And a party?", { timestamp: NOW - 1_000 }),
			row("a-2", "assistant", FIRST_WORDS, {
				timestamp: NOW,
				isStreaming: true,
			}),
		];

		const places = placeReplySegments(messages, [unstamped], "a-2");

		expect(places.get("a-2")?.question).toBe(unstamped);
		expect(places.get("a-1")?.question).toBeNull();
		// With nothing streaming it belongs to no row: it is not this chat's to draw yet.
		const idle = placeReplySegments(messages, [unstamped], null);
		expect(idle.get("a-1")?.question).toBeNull();
		expect(idle.get("a-2")?.question).toBeNull();
		// An id that names no row of the list, or a person's row, takes it nowhere.
		for (const id of ["a-9", "u-2"]) {
			const stranger = placeReplySegments(messages, [unstamped], id);
			expect(stranger.get("a-1")?.question).toBeNull();
			expect(stranger.get("a-2")?.question).toBeNull();
		}
	});

	it("prefers a question stamped on the streaming row to one that is not stamped yet", () => {
		const stamped = asked({
			id: "q-stamped",
			assistantMessageId: "a-2",
			status: "waiting",
		});
		const unstamped = asked({
			id: "q-unstamped",
			assistantMessageId: null,
			createdAt: NOW,
		});
		const messages = [
			row("u-1", "user", "Plan dad's 60th"),
			row("a-2", "assistant", FIRST_WORDS, { isStreaming: true }),
		];

		// Whichever order the chat's questions were read in.
		for (const questions of [
			[unstamped, stamped],
			[stamped, unstamped],
		]) {
			expect(
				placeReplySegments(messages, questions, "a-2").get("a-2")?.question,
			).toBe(stamped);
		}
	});

	it("takes an unstamped question made no earlier than a second before the streaming row, as a pending write is", () => {
		const messages = [
			row("u-1", "user", "Plan dad's 60th"),
			row("a-1", "assistant", FIRST_WORDS, {
				timestamp: NOW,
				isStreaming: true,
			}),
		];
		const madeAt = (createdAt: number) =>
			placeReplySegments(
				messages,
				[asked({ assistantMessageId: null, createdAt })],
				"a-1",
			).get("a-1")?.question;

		expect(madeAt(NOW - 1_000)).not.toBeNull();
		expect(madeAt(NOW - 999)).not.toBeNull();
		expect(madeAt(NOW - 1_001)).toBeNull();
		expect(madeAt(NOW - 3_600_000)).toBeNull();
	});

	it("puts a stamped question on its own row whatever is streaming, and on no other", () => {
		const stamped = asked({ assistantMessageId: "a-1", status: "answered" });
		const places = placeReplySegments(
			[
				row("u-1", "user", "Plan dad's 60th"),
				row("a-1", "assistant", FIRST_WORDS),
				row("a-2", "assistant", SECOND_WORDS, {
					continuesMessageId: "a-1",
					isStreaming: true,
				}),
			],
			[stamped],
			"a-2",
		);

		expect(places.get("a-1")?.question).toBe(stamped);
		expect(places.get("a-2")?.question).toBeNull();
	});

	it("draws nothing for a question whose row is not on the page", () => {
		const places = placeReplySegments(
			[row("u-1", "user", "Hi"), row("a-1", "assistant", FIRST_WORDS)],
			[asked({ assistantMessageId: "a-elsewhere" })],
			null,
		);

		expect(places.get("a-1")?.question).toBeNull();
		expect(places.get("a-1")?.continuedBelow).toBe(false);
	});

	it("gives a reply of one row the plain place, and the person's rows none", () => {
		const places = placeReplySegments(
			[
				row("u-1", "user", "Hi"),
				row("a-1", "assistant", FIRST_WORDS),
				row("u-2", "user", "Thanks"),
				row("a-2", "assistant", SECOND_WORDS),
			],
			[],
			null,
		);

		expect([...places.keys()]).toEqual(["a-1", "a-2"]);
		expect(places.get("a-1")).toEqual({
			firstMessageId: "a-1",
			continuesAbove: false,
			continuedBelow: false,
			question: null,
			copyText: null,
			userIntent: null,
			drawsSources: true,
			sources: null,
		});
		expect(places.get("a-2")).toEqual({
			firstMessageId: "a-2",
			continuesAbove: false,
			continuedBelow: false,
			question: null,
			copyText: null,
			userIntent: null,
			drawsSources: true,
			sources: null,
		});
	});

	it("names the first row on every row of a longer reply, and sets the copy text on its last row only", () => {
		const places = placeReplySegments(
			[
				row("u-1", "user", "Plan dad's 60th"),
				row("a-1", "assistant", "One."),
				row("a-2", "assistant", "Two.", { continuesMessageId: "a-1" }),
				row("a-3", "assistant", "Three.", { continuesMessageId: "a-2" }),
				row("u-2", "user", "Thanks"),
				row("a-4", "assistant", "Four."),
			],
			[
				asked({ status: "answered" }),
				asked({
					id: "q-2",
					assistantMessageId: "a-2",
					toolCallId: "call-2",
					status: "closed",
				}),
			],
			null,
		);

		expect(
			["a-1", "a-2", "a-3"].map((id) => places.get(id)?.firstMessageId),
		).toEqual(["a-1", "a-1", "a-1"]);
		expect(
			["a-1", "a-2", "a-3"].map((id) => places.get(id)?.continuesAbove),
		).toEqual([false, true, true]);
		expect(
			["a-1", "a-2", "a-3"].map((id) => places.get(id)?.continuedBelow),
		).toEqual([true, true, false]);
		expect(["a-1", "a-2", "a-3"].map((id) => places.get(id)?.copyText)).toEqual(
			[null, null, "One.\n\nTwo.\n\nThree."],
		);
		// The next turn is a reply of its own.
		expect(places.get("a-4")).toMatchObject({
			firstMessageId: "a-4",
			continuesAbove: false,
			copyText: null,
		});
	});

	it("carries what the person chose from the reply's first row to its last row only", () => {
		const chosen = {
			skill: { id: "skill-1", displayName: "Contract review" },
			webSearch: true as const,
		};
		const places = placeReplySegments(
			[
				row("u-1", "user", "Plan dad's 60th"),
				row("a-1", "assistant", "One.", { userIntent: chosen }),
				row("a-2", "assistant", "Two.", { continuesMessageId: "a-1" }),
				// The last row's own record is not the reply's: the choice was made once.
				row("a-3", "assistant", "Three.", {
					continuesMessageId: "a-2",
					userIntent: { webSearch: true },
				}),
				// A reply of one row has its own line to say its own choices.
				row("u-2", "user", "Thanks"),
				row("a-4", "assistant", "Four.", { userIntent: chosen }),
				// A first row that records no choice has none to carry.
				row("u-3", "user", "More"),
				row("a-5", "assistant", "Five."),
				row("a-6", "assistant", "Six.", { continuesMessageId: "a-5" }),
			],
			[],
			null,
		);

		const intentOf = (id: string) => places.get(id)?.userIntent;
		// Set on the last row of a reply of more than one row, from its first...
		expect(intentOf("a-3")).toBe(chosen);
		// ...and nowhere else: not on the rows the reply goes on from.
		expect(intentOf("a-1")).toBeNull();
		expect(intentOf("a-2")).toBeNull();
		expect(intentOf("a-4")).toBeNull();
		expect(intentOf("a-5")).toBeNull();
		expect(intentOf("a-6")).toBeNull();
	});

	it("copies what Copy copies of each row: no thinking text, trimmed, and the rows with no words left out", () => {
		const places = placeReplySegments(
			[
				row("u-1", "user", "Plan dad's 60th"),
				row(
					"a-1",
					"assistant",
					"<thinking>Hidden thought.</thinking>  First words.  ",
				),
				row("a-2", "assistant", "  \n", { continuesMessageId: "a-1" }),
				row("a-3", "assistant", "<thinking>Only a thought.</thinking>", {
					continuesMessageId: "a-2",
				}),
				row("a-4", "assistant", "Last words.", { continuesMessageId: "a-3" }),
			],
			[],
			null,
		);

		expect(places.get("a-4")?.copyText).toBe("First words.\n\nLast words.");
	});
});

// Owner, 2026-11-05, after his first live test: the asking segment's Sources between its
// folded line and the words that carry on "read as the reply ending". A reply has one
// Sources panel, at its end, from every segment's evidence.
describe("a reply's Sources", () => {
	const web = (...ids: string[]) =>
		({
			structuredWebSearch: true,
			groups: [
				{
					sourceType: "web",
					label: "Web",
					reranked: false,
					items: ids.map((id) => ({
						id,
						title: id,
						url: `https://example.com/${id}`,
					})),
				},
			],
		}) as unknown as ChatMessage["evidenceSummary"];

	const document = {
		structuredWebSearch: false,
		groups: [
			{
				sourceType: "document",
				label: "Documents",
				reranked: true,
				items: [{ id: "d1", title: "Notes", artifactId: "artifact-1" }],
			},
		],
	} as unknown as ChatMessage["evidenceSummary"];

	it("is drawn once, by the last row of a reply, from every row's evidence", () => {
		const places = placeReplySegments(
			[
				row("u-1", "user", "Plan dad's 60th"),
				row("a-1", "assistant", FIRST_WORDS, { evidenceSummary: web("w1") }),
				row("a-2", "assistant", "More.", {
					continuesMessageId: "a-1",
					evidenceSummary: web("w2", "w3"),
				}),
				row("a-3", "assistant", SECOND_WORDS, {
					continuesMessageId: "a-2",
					evidenceSummary: document,
				}),
			],
			[],
			null,
		);

		expect(places.get("a-1")).toMatchObject({
			drawsSources: false,
			sources: null,
		});
		expect(places.get("a-2")).toMatchObject({
			drawsSources: false,
			sources: null,
		});
		const last = places.get("a-3");
		expect(last?.drawsSources).toBe(true);
		expect(
			last?.sources?.groups.map((group) => [
				group.sourceType,
				group.items.map((item) => item.id),
			]),
		).toEqual([
			["web", ["w1", "w2", "w3"]],
			["document", ["d1"]],
		]);
	});

	it("leaves a reply of one row to draw its own", () => {
		const places = placeReplySegments(
			[
				row("u-1", "user", "Hi"),
				row("a-1", "assistant", "Hello.", { evidenceSummary: web("w1") }),
			],
			[],
			null,
		);
		expect(places.get("a-1")).toMatchObject({
			drawsSources: true,
			sources: null,
		});
	});

	it("leaves the row that asks to draw its own while its question waits: it is the end of the reply so far", () => {
		const places = placeReplySegments(
			[
				row("u-1", "user", "Plan dad's 60th"),
				row("a-1", "assistant", FIRST_WORDS, { evidenceSummary: web("w1") }),
			],
			[asked()],
			null,
		);
		expect(places.get("a-1")).toMatchObject({
			continuedBelow: true,
			drawsSources: true,
			sources: null,
		});
	});

	describe("merged", () => {
		it("keeps each source once, whichever row read it, and the kinds in the order they first appeared", () => {
			const merged = mergeReplyEvidence([
				{ evidenceSummary: web("w1", "w2") },
				{ evidenceSummary: document },
				{ evidenceSummary: web("w2", "w3") },
			]);
			expect(merged?.structuredWebSearch).toBe(true);
			expect(merged?.groups.map((group) => group.sourceType)).toEqual([
				"web",
				"document",
			]);
			expect(merged?.groups[0].items.map((item) => item.id)).toEqual([
				"w1",
				"w2",
				"w3",
			]);
			// a group is reranked when any row's was
			expect(merged?.groups[1].reranked).toBe(true);
		});

		it("does not change the rows' own evidence", () => {
			const first = web("w1");
			const second = web("w2");
			mergeReplyEvidence([
				{ evidenceSummary: first },
				{ evidenceSummary: second },
			]);
			expect(first?.groups[0].items).toHaveLength(1);
			expect(second?.groups[0].items).toHaveLength(1);
		});

		it("is nothing when no row has any", () => {
			expect(
				mergeReplyEvidence([
					{ evidenceSummary: undefined },
					{ evidenceSummary: { structuredWebSearch: false, groups: [] } },
				]),
			).toBeNull();
		});
	});
});

describe("the helpers a page uses to read a reply in segments", () => {
	const messages = [
		row("u-1", "user", "Plan dad's 60th"),
		row("a-1", "assistant", FIRST_WORDS),
		row("a-2", "assistant", SECOND_WORDS, { continuesMessageId: "a-1" }),
		row("a-3", "assistant", "Last.", { continuesMessageId: "a-2" }),
		row("u-2", "user", "Thanks"),
		row("a-4", "assistant", "You're welcome."),
	];

	it("finds a reply's first row, its last index and the person's message", () => {
		// The first row, from any row of the reply.
		expect(replyFirstMessageId(messages, "a-3")).toBe("a-1");
		expect(replyFirstMessageId(messages, "a-2")).toBe("a-1");
		expect(replyFirstMessageId(messages, "a-1")).toBe("a-1");
		expect(replyFirstMessageId(messages, "a-4")).toBe("a-4");
		expect(replyFirstMessageId(messages, "u-1")).toBe("u-1");
		expect(replyFirstMessageId(messages, "a-gone")).toBe("a-gone");

		// The last index, from any index of the reply.
		expect(replyEndIndex(messages, 1)).toBe(3);
		expect(replyEndIndex(messages, 2)).toBe(3);
		expect(replyEndIndex(messages, 3)).toBe(3);
		expect(replyEndIndex(messages, 5)).toBe(5);
		expect(replyEndIndex(messages, 0)).toBe(0);

		// The person's message is the one right before the reply's first row.
		expect(personMessageOfReply(messages, "a-3")?.id).toBe("u-1");
		expect(personMessageOfReply(messages, "a-1")?.id).toBe("u-1");
		expect(personMessageOfReply(messages, "a-4")?.id).toBe("u-2");
		expect(personMessageOfReply(messages, "a-4")?.content).toBe("Thanks");
	});

	it("finds no person's message for a reply that opens the chat, or a row that is not there", () => {
		const opening = [
			row("a-0", "assistant", "Welcome."),
			row("a-1", "assistant", "More.", { continuesMessageId: "a-0" }),
		];

		expect(personMessageOfReply(opening, "a-1")).toBeNull();
		expect(personMessageOfReply(opening, "a-0")).toBeNull();
		expect(personMessageOfReply(messages, "a-gone")).toBeNull();
		expect(personMessageOfReply([], "a-1")).toBeNull();
	});

	it("does not take a reply that follows another reply for a person's message", () => {
		// Two replies in a row, the second not linked to the first: no person's message.
		const doubled = [
			row("u-1", "user", "Hi"),
			row("a-1", "assistant", "Hello."),
			row("a-2", "assistant", "Anything else?"),
		];

		expect(personMessageOfReply(doubled, "a-2")).toBeNull();
		expect(replyFirstMessageId(doubled, "a-2")).toBe("a-2");
		expect(replyEndIndex(doubled, 1)).toBe(1);
	});

	it("tells a row that continues the row above from one that does not", () => {
		// Only an assistant row carries on from an assistant row: a link that names a
		// person's row, or sits on one, is no continuation.
		const odd = [
			row("u-1", "user", "Hi"),
			row("a-1", "assistant", "Hello.", { continuesMessageId: "u-1" }),
			row("u-2", "user", "Thanks", { continuesMessageId: "a-1" }),
		];
		expect(continuesRowAbove(odd, 1)).toBe(false);
		expect(continuesRowAbove(odd, 2)).toBe(false);
		expect(replyFirstMessageId(odd, "a-1")).toBe("a-1");
		expect(replyEndIndex(odd, 1)).toBe(1);

		expect(continuesRowAbove(messages, 2)).toBe(true);
		expect(continuesRowAbove(messages, 3)).toBe(true);
		expect(continuesRowAbove(messages, 1)).toBe(false);
		expect(continuesRowAbove(messages, 0)).toBe(false);
		expect(continuesRowAbove(messages, 5)).toBe(false);
		expect(continuesRowAbove(messages, 99)).toBe(false);
		expect(continuesRowAbove(messages, -1)).toBe(false);
	});
});
