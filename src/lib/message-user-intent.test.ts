import { describe, expect, it } from "vitest";
import {
	buildMessageUserIntent,
	parseMessageUserIntent,
} from "./message-user-intent";

describe("buildMessageUserIntent", () => {
	it("is undefined — never {} — when the user chose nothing", () => {
		expect(buildMessageUserIntent({})).toBeUndefined();
		expect(
			buildMessageUserIntent({ skill: null, forceWebSearch: false }),
		).toBeUndefined();
	});

	it("records the applied skill by id and display name only", () => {
		const pendingSkill = {
			id: "skill-1",
			ownership: "user",
			displayName: "Invoice reply",
			baseSkillId: null,
		};
		expect(buildMessageUserIntent({ skill: pendingSkill })).toEqual({
			skill: { id: "skill-1", displayName: "Invoice reply" },
		});
	});

	it("records a forced web search", () => {
		expect(buildMessageUserIntent({ forceWebSearch: true })).toEqual({
			webSearch: true,
		});
	});

	it("records both when the user chose both", () => {
		expect(
			buildMessageUserIntent({
				skill: { id: "skill-1", displayName: " Invoice reply " },
				forceWebSearch: true,
			}),
		).toEqual({
			skill: { id: "skill-1", displayName: "Invoice reply" },
			webSearch: true,
		});
	});

	it("does not record a skill it cannot name", () => {
		expect(
			buildMessageUserIntent({ skill: { id: "skill-1", displayName: "  " } }),
		).toBeUndefined();
	});

	// A skill display name is capped at 120 where it is written, so a longer
	// one did not come from this app's skill table — and it would go straight
	// onto a chip. Refused whole rather than truncated, and the other key the
	// user chose survives.
	it("refuses a skill whose name or id is longer than it can be", () => {
		expect(
			buildMessageUserIntent({
				skill: { id: "skill-1", displayName: "x".repeat(121) },
				forceWebSearch: true,
			}),
		).toEqual({ webSearch: true });
		expect(
			buildMessageUserIntent({
				skill: { id: "s".repeat(201), displayName: "Invoice reply" },
			}),
		).toBeUndefined();
		expect(
			buildMessageUserIntent({
				skill: { id: "skill-1", displayName: "x".repeat(120) },
			}),
		).toEqual({ skill: { id: "skill-1", displayName: "x".repeat(120) } });
	});

	// The client builds this from a `pendingSkill` that arrived as JSON, so a
	// shape TypeScript believes in can still be wrong at runtime — and a throw
	// here would take the whole send with it.
	it("does not throw on a skill whose fields are not strings", () => {
		const malformed = { id: 7, displayName: null } as unknown as {
			id: string;
			displayName: string;
		};
		expect(
			buildMessageUserIntent({ skill: malformed, forceWebSearch: true }),
		).toEqual({ webSearch: true });
	});
});

describe("parseMessageUserIntent", () => {
	it("round-trips a record through JSON", () => {
		const intent = buildMessageUserIntent({
			skill: { id: "skill-1", displayName: "Invoice reply" },
			forceWebSearch: true,
		});
		expect(parseMessageUserIntent(JSON.parse(JSON.stringify(intent)))).toEqual(
			intent,
		);
	});

	// Every message persisted before the record existed.
	it("is undefined for an absent record", () => {
		expect(parseMessageUserIntent(undefined)).toBeUndefined();
		expect(parseMessageUserIntent(null)).toBeUndefined();
	});

	it("is undefined for anything that is not a record", () => {
		expect(parseMessageUserIntent("web")).toBeUndefined();
		expect(parseMessageUserIntent([])).toBeUndefined();
		expect(parseMessageUserIntent({})).toBeUndefined();
	});

	it("keeps the valid key and drops the malformed one", () => {
		expect(
			parseMessageUserIntent({ skill: { id: 7 }, webSearch: true }),
		).toEqual({ webSearch: true });
		expect(
			parseMessageUserIntent({
				skill: { id: "skill-1", displayName: "Invoice reply" },
				webSearch: "yes",
			}),
		).toEqual({ skill: { id: "skill-1", displayName: "Invoice reply" } });
	});

	// The same bound the builder enforces, reached through the persisted /
	// streamed side: an oversized label never becomes a chip.
	it("drops an oversized skill name read back from JSON", () => {
		expect(
			parseMessageUserIntent({
				skill: { id: "skill-1", displayName: "x".repeat(121) },
				webSearch: true,
			}),
		).toEqual({ webSearch: true });
	});

	// Only `skill` and `webSearch` are read, onto a fresh literal.
	it("does not carry a prototype key or any other key through", () => {
		const parsed = parseMessageUserIntent(
			JSON.parse(
				'{"__proto__":{"polluted":true},"webSearch":true,"atlas":"in-depth"}',
			),
		);
		expect(parsed).toEqual({ webSearch: true });
		expect(Object.keys(parsed ?? {})).toEqual(["webSearch"]);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});
