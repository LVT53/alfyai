import { and, eq, notInArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	conversations,
	imageSearchAttempts,
	imageSearchMeasurement,
	normalChatTurns,
} from "$lib/server/db/schema";
import { getMonthlyImageDisplays } from "./display";

export interface PictureSearchMonth {
	month: string;
	coverage: "none" | "partial" | "full";
	normalChatTurns: number;
	searchedTurns: number;
	attempts: number;
	failed: number;
	empty: number;
	candidates: number;
	extraAttempts: number;
	meteredExtraCalls: number;
	extraListMicros: number;
	extraBilledMicros: number;
	imageCalls: number;
	imageListMicros: number;
	imageBilledMicros: number;
	sharedListMicros: number;
	sharedBilledMicros: number;
	shown: number;
	loaded: number;
	loadFailed: number;
}

export async function getPictureAnalytics(
	usage: readonly {
		userId: string;
		modelId: string;
		billingMonth: string;
		costUsdMicros: number;
		parallelImageExtra?: boolean | null;
	}[],
	options: {
		month: string | null;
		imageModelId: string;
		priceMicros: number;
		userId: string | null;
		excludedUserIds: string[];
	},
) {
	const tracking = db.select().from(imageSearchMeasurement).get();
	if (!tracking) throw new Error("Missing image search measurement start");
	const since = tracking.startedAt;
	const startMonth = since.toISOString().slice(0, 7);
	const months = new Map<string, PictureSearchMonth>();
	function bucket(month: string) {
		let item = months.get(month);
		if (!item) {
			item = {
				month,
				coverage:
					month < startMonth
						? "none"
						: month === startMonth &&
								since.toISOString().slice(8) !== "01T00:00:00.000Z"
							? "partial"
							: "full",
				normalChatTurns: 0,
				searchedTurns: 0,
				attempts: 0,
				failed: 0,
				empty: 0,
				candidates: 0,
				extraAttempts: 0,
				meteredExtraCalls: 0,
				extraListMicros: 0,
				extraBilledMicros: 0,
				imageCalls: 0,
				imageListMicros: 0,
				imageBilledMicros: 0,
				sharedListMicros: 0,
				sharedBilledMicros: 0,
				shown: 0,
				loaded: 0,
				loadFailed: 0,
			};
			months.set(month, item);
		}
		return item;
	}
	const current = new Date().toISOString().slice(0, 7);
	bucket(current);
	if (
		options.month &&
		/^\d{4}-(0[1-9]|1[0-2])$/.test(options.month) &&
		options.month <= current
	)
		bucket(options.month);
	const excluded = new Set(options.excludedUserIds);
	for (const event of usage) {
		if (!event.modelId.startsWith("parallel:")) continue;
		const m = bucket(event.billingMonth);
		m.sharedListMicros += options.priceMicros;
		m.sharedBilledMicros += event.costUsdMicros;
		if (
			event.modelId !== options.imageModelId ||
			excluded.has(event.userId) ||
			(options.userId && event.userId !== options.userId)
		)
			continue;
		m.imageCalls++;
		m.imageListMicros += options.priceMicros;
		m.imageBilledMicros += event.costUsdMicros;
		if (event.parallelImageExtra) {
			m.meteredExtraCalls++;
			m.extraListMicros += options.priceMicros;
			m.extraBilledMicros += event.costUsdMicros;
		}
	}
	const ownerScope =
		and(
			options.userId ? eq(conversations.userId, options.userId) : undefined,
			options.excludedUserIds.length
				? notInArray(conversations.userId, options.excludedUserIds)
				: undefined,
		) ?? sql`1`;
	const counts = db.all<
		Pick<
			PictureSearchMonth,
			| "month"
			| "attempts"
			| "searchedTurns"
			| "failed"
			| "empty"
			| "extraAttempts"
			| "candidates"
		>
	>(sql`
  WITH per_turn AS (
   SELECT strftime('%Y-%m', started_at, 'unixepoch') AS month, conversation_id, turn_id,
    COUNT(*) AS calls, SUM(${imageSearchAttempts.status}='failed') AS failures, SUM(${imageSearchAttempts.status}='done' AND candidate_count=0) AS empty,
    SUM(candidate_count) AS candidates, SUM(is_extra) AS extra
   FROM ${imageSearchAttempts} JOIN ${conversations} ON ${conversations.id}=${imageSearchAttempts.conversationId}
   WHERE ${ownerScope} GROUP BY month, conversation_id, turn_id
  )
  SELECT month, COUNT(*) AS searchedTurns, SUM(calls) AS attempts, SUM(failures) AS failed,
   SUM(empty) AS empty, SUM(candidates) AS candidates, SUM(extra) AS extraAttempts FROM per_turn GROUP BY month`);
	for (const row of counts) Object.assign(bucket(row.month), row);
	// Count each logical turn once per active UTC month, including an ongoing
	// turn which began before midnight and searched again in the new month.
	const totals = db.all<{ month: string; total: number }>(sql`
  WITH active AS (
   SELECT strftime('%Y-%m',t.created_at,'unixepoch') AS month, t.conversation_id, t.turn_id
   FROM ${normalChatTurns} t INNER JOIN ${conversations} ON ${conversations.id}=t.conversation_id
   WHERE t.created_at>=${Math.floor(since.getTime() / 1000)} AND ${conversations.memoryIncognito}=0 AND ${ownerScope}
   UNION
   SELECT strftime('%Y-%m',started_at,'unixepoch'),conversation_id,turn_id FROM ${imageSearchAttempts}
   JOIN ${conversations} ON ${conversations.id}=${imageSearchAttempts.conversationId} WHERE ${ownerScope}
  )
  SELECT month,COUNT(*) AS total FROM active GROUP BY month`);
	for (const row of totals) bucket(row.month).normalChatTurns = row.total;
	for (const row of await getMonthlyImageDisplays(options))
		Object.assign(bucket(row.month), row);
	return {
		pictureTrackingSince: since.toISOString(),
		pictureMonths: [...months.values()].sort((a, b) =>
			a.month.localeCompare(b.month),
		),
	};
}
