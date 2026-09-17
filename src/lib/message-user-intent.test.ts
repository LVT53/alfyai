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
});
