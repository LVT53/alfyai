import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, expect, it, vi } from "vitest";

const path = `/tmp/alfyai-image-counts-${randomUUID()}.db`;
afterEach(async () => {
	(await import("$lib/server/db")).sqlite.close();
	vi.unstubAllEnvs();
	rmSync(path, { force: true });
});

it("measures follow-ups in start order, including after failure, while reconciling exact shared allowance costs", async () => {
	vi.stubEnv("DATABASE_PATH", path);
	const { db, sqlite } = await import("$lib/server/db");
	migrate(db, { migrationsFolder: "./drizzle" });
	sqlite.exec(`INSERT INTO users(id,email,password_hash,name) VALUES ('u','u@x.com','x','u');
 INSERT INTO conversations(id,user_id,title) VALUES ('c','u','Chat');
 INSERT INTO conversations(id,user_id,title,memory_incognito) VALUES ('p','u','Private',1);
 INSERT INTO normal_chat_turns(segment_id,turn_id,conversation_id,owner_id) VALUES ('s','t','c','u'),('ask','t','c','u'),('other','t2','c','u');
 INSERT INTO admin_config(key,value,updated_at,updated_by) VALUES ('PARALLEL_FREE_MONTHLY_USD','0.0015',0,'u');`);
	await (await import("$lib/server/config-store")).refreshConfig();
	const { startImageSearch, finishImageSearch } = await import("./search");
	const { recordParallelUsage, getAnalyticsDashboardReadModel } = await import(
		"../analytics"
	);
	const start = (conversationId = "c", turnId = "t") =>
		startImageSearch({ conversationId, turnId, userId: "u" });
	const first = start();
	const followup = start();
	expect(first).toBeTruthy();
	expect(followup).toBeTruthy();
	expect(start("p")).toBeUndefined();
	await recordParallelUsage({ tool: "research_web", userId: "u" });
	finishImageSearch(followup, 2);
	const book = () =>
		recordParallelUsage({
			tool: "image_search",
			userId: "u",
			conversationId: "c",
			eventId: followup,
		});
	await book();
	await book();
	finishImageSearch(first, null);
	const empty = start("c", "t2");
	finishImageSearch(empty, 0);
	await recordParallelUsage({
		tool: "image_search",
		userId: "u",
		conversationId: "c",
		eventId: empty,
	});
	const user = {
		id: "u",
		role: "admin",
		email: "u@x.com",
		displayName: "Admin",
		profilePicture: null,
		titleLanguage: "auto",
		uiLanguage: "en",
	} as const;
	const response = await getAnalyticsDashboardReadModel({
		user,
		systemMonth: "2020-01",
	});
	const rows = response.system?.parallel?.pictureMonths;
	expect(rows?.at(-1)).toMatchObject({
		attempts: 3,
		failed: 1,
		empty: 1,
		candidates: 2,
		searchedTurns: 2,
		normalChatTurns: 2,
		extraAttempts: 1,
		meteredExtraCalls: 1,
		extraListMicros: 1000,
		extraBilledMicros: 500,
		imageListMicros: 2000,
		imageBilledMicros: 1500,
		sharedListMicros: 3000,
		sharedBilledMicros: 1500,
		coverage: "partial",
	});
	expect(rows?.find((r) => r.month === "2020-01")).toMatchObject({
		coverage: "none",
		attempts: 0,
	});
	const excluded = await getAnalyticsDashboardReadModel({
		user,
		excludedUserIds: ["u"],
		systemMonth: "2020-01",
	});
	expect(excluded.system?.parallel?.pictureMonths?.at(-1)).toMatchObject({
		attempts: 0,
		searchedTurns: 0,
		normalChatTurns: 0,
		extraListMicros: 0,
		imageListMicros: 0,
		sharedListMicros: 3000,
	});
	expect(excluded.system?.parallel?.allowance).toMatchObject({
		monthListMicros: 3000,
		monthBilledMicros: 1500,
	});
	sqlite.exec("DELETE FROM conversations WHERE id='c'");
	const deleted = await getAnalyticsDashboardReadModel({ user });
	expect(deleted.system?.parallel?.pictureMonths?.at(-1)).toMatchObject({
		attempts: 0,
		extraBilledMicros: 500,
	});
});
