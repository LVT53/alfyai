import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase } from "$lib/server/db/in-memory";
import type { ThinkingSegment } from "$lib/server/services/messages-types";

const state = vi.hoisted(() => ({
	current: null as ReturnType<typeof createInMemoryDatabase> | null,
}));
vi.mock("$lib/server/db", () => ({
	get db() {
		if (!state.current) throw new Error("Missing test database");
		return state.current.db;
	},
}));

import {
	getMonthlyImageDisplays,
	recordImageLoad,
	recordReplyImages,
} from "./display";

const url = "https://pictures.example/market.jpg?a=1&sig=x%2Fy";
const id = createHash("sha256").update(url).digest("hex");
const calls: ThinkingSegment[] = [
	{
		type: "tool_call",
		callId: "c",
		name: "image_search",
		status: "done",
		input: { query: "market" },
		candidates: [
			{
				id: "first",
				title: "Market",
				url,
				sourceType: "web",
				metadata: { provider: "parallel", thumbnail: url },
			},
		],
	},
];
const content = `![Market](${url}) ![same again](${url})`;
beforeEach(() => {
	state.current?.close();
	state.current = createInMemoryDatabase();
	state.current.sqlite.exec(`insert into users(id,email,password_hash,name) values ('u','u@test','x','U'),('other','o@test','x','O');
 insert into conversations(id,user_id,title) values ('chat','u','Chat');
 insert into messages(id,conversation_id,role,created_at,content) values ('m','chat','assistant',1767225600,'content');`);
});
describe("inline picture analytics", () => {
	it("keeps one unknown per shown picture, authenticates a report, and preserves a later successful load across retries", async () => {
		await recordReplyImages("m", content, calls);
		await recordReplyImages("m", content, calls);
		expect(await getMonthlyImageDisplays()).toEqual([
			{ month: "2026-01", shown: 1, loaded: 0, loadFailed: 0 },
		]);
		expect(
			await getMonthlyImageDisplays({ userId: "other", excludedUserIds: [] }),
		).toEqual([]);
		expect(
			await getMonthlyImageDisplays({ userId: null, excludedUserIds: ["u"] }),
		).toEqual([]);
		await recordImageLoad("other", "m", id, "loaded");
		await recordImageLoad("u", "m", "f".repeat(64), "loaded");
		await recordImageLoad("u", "m", id, "failed");
		expect(await getMonthlyImageDisplays()).toEqual([
			{ month: "2026-01", shown: 1, loaded: 0, loadFailed: 1 },
		]);
		await recordImageLoad("u", "m", id, "loaded");
		await recordImageLoad("u", "m", id, "failed");
		expect(await getMonthlyImageDisplays()).toEqual([
			{ month: "2026-01", shown: 1, loaded: 1, loadFailed: 0 },
		]);
		state.current?.sqlite.exec("delete from messages");
		expect(await getMonthlyImageDisplays()).toEqual([]);
	});
	it("ignores candidate-only, link-only, code, and unauthorized embeds", async () => {
		await recordReplyImages(
			"m",
			`[Photo](${url})\n\n\`![sample](${url})\`\n\n![Other](https://example.org/unrelated.jpg)`,
			calls,
		);
		expect(await getMonthlyImageDisplays()).toEqual([]);
	});
	it("includes reference-style images and skips fenced examples when counting rendered pictures", async () => {
		await recordReplyImages(
			"m",
			["```md", `![example](${url})`, "```"].join("\n"),
			calls,
		);
		expect(await getMonthlyImageDisplays()).toEqual([]);
		await recordReplyImages("m", `![Market][photo]\n\n[photo]: ${url}`, calls);
		expect(await getMonthlyImageDisplays()).toEqual([
			{ month: "2026-01", shown: 1, loaded: 0, loadFailed: 0 },
		]);
	});
	it("excludes incognito and imported messages", async () => {
		state.current?.sqlite.exec("update conversations set memory_incognito=1");
		await recordReplyImages("m", content, calls);
		state.current?.sqlite.exec(
			"update conversations set memory_incognito=0; update messages set import_source='chatgpt'",
		);
		await recordReplyImages("m", content, calls);
		expect(await getMonthlyImageDisplays()).toEqual([]);
	});
});
