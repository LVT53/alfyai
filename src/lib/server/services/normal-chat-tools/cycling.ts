import { z } from "zod";
import type { ConnectorReasonCode } from "$lib/shared/tool-reasons";
import {
	loadBoschForQuestion,
	type readBoschSnapshot,
} from "../connections/providers/bosch-flow-bridge";
import {
	matchingConnections,
	resolveConnectionsForCapability,
} from "../connections/resolve";
import type { ToolEvidenceCandidate } from "../message-evidence";
import { applyLocalDistillGate } from "./connector-distill";
import { withReasonCode } from "./shared";

export const cyclingToolInputSchema = z.object({
	action: z.enum(["bikes", "rides", "summary"]),
	account: z.string().trim().optional(),
	start: z.iso.datetime({ offset: true }).optional(),
	end: z.iso.datetime({ offset: true }).optional(),
	limit: z.number().int().min(1).max(50).optional(),
	offset: z.number().int().min(0).max(2000).optional(),
});
type CyclingInput = z.infer<typeof cyclingToolInputSchema>;
type Snapshot = NonNullable<Awaited<ReturnType<typeof readBoschSnapshot>>>;
type Payload = {
	success: boolean;
	name: "cycling";
	sourceType: "tool";
	action: CyclingInput["action"];
	message: string;
	syncedAt: string | null;
	fresh: boolean;
	complete: boolean;
	bikes: Snapshot["bikes"];
	rides: Snapshot["rides"];
	nextOffset: number | null;
	summary: {
		rideCount: number;
		distanceMeters: number;
		ridesWithoutDistance: number;
	} | null;
	citations: { label: string; url: string }[];
};
export async function runCyclingTool(
	userId: string,
	input: CyclingInput,
	modelId: string,
) {
	const base: Payload = {
		success: false,
		name: "cycling",
		sourceType: "tool",
		action: input.action,
		message: "",
		syncedAt: null,
		fresh: false,
		complete: false,
		bikes: [],
		rides: [],
		nextOffset: null,
		summary: null,
		citations: [],
	};
	const fail = (reason: ConnectorReasonCode, message: string) => ({
		modelPayload: withReasonCode({ ...base, message }, reason),
		candidates: [] as ToolEvidenceCandidate[],
	});
	const lower = input.start ? Date.parse(input.start) : -Infinity;
	const upper = input.end ? Date.parse(input.end) : Infinity;
	if (
		lower >= upper ||
		Number.isNaN(lower) ||
		Number.isNaN(upper) ||
		(input.action === "summary" && (!input.start || !input.end))
	)
		return fail(
			"not_supported",
			"Use an explicit start and later end with time zones for period totals.",
		);
	try {
		const connections = await resolveConnectionsForCapability(
			userId,
			"cycling",
		);
		const selected = input.account
			? matchingConnections(connections, input.account)
			: connections;
		if (selected.length !== 1)
			return fail(
				connections.length ? "no_such_account" : "not_connected",
				connections.length
					? "Specify which rider account to read."
					: "Pair a Bosch eBike Flow bridge first.",
			);
		const { snapshot, fresh } = await loadBoschForQuestion(
			userId,
			selected[0].id,
		);
		if (!snapshot)
			return fail(
				"not_set_up",
				"The rider's service could not return live data and there is no saved snapshot.",
			);
		const data: Payload = {
			...base,
			success: true,
			syncedAt: new Date(snapshot.syncedAt).toISOString(),
			complete: snapshot.complete,
			fresh,
			message: fresh
				? "Bosch Flow returned fresh data for this question."
				: `The service could not return live data. Only cached records from ${new Date(snapshot.syncedAt).toISOString()} are available. State that timestamp in the answer.`,
		};

		if (input.action === "bikes") data.bikes = snapshot.bikes;
		else {
			const rides = [...new Map(snapshot.rides.map((r) => [r.id, r])).values()]
				.filter((r) => {
					const t = Date.parse(r.startTime);
					return t >= lower && t < upper;
				})
				.sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
			if (input.action === "rides") {
				const offset = input.offset ?? 0;
				data.rides = rides.slice(offset, offset + (input.limit ?? 20));
				if (offset + data.rides.length < rides.length)
					data.nextOffset = offset + data.rides.length;
			} else
				data.summary = {
					rideCount: rides.length,
					distanceMeters: rides.reduce(
						(m, r) => m + (r.distanceMeters ?? 0),
						0,
					),
					ridesWithoutDistance: rides.filter((r) => r.distanceMeters === null)
						.length,
				};
			if (data.summary?.ridesWithoutDistance)
				data.message +=
					" Some rides lack measured distance. Give the measured subtotal and the number missing distance.";
			if (!data.complete)
				data.message +=
					" History is incomplete. Report only the recorded rides and measured distance, never a definitive total.";
		}
		const candidates: ToolEvidenceCandidate[] = [
			...data.bikes.map((bike, index) => ({
				id: `cycling:${selected[0].id}:bike:${bike.id ?? index}`,
				title: bike.name || "Bosch eBike Flow",
				url: "",
				snippet: bike.name ?? "",
				sourceType: "tool" as const,
			})),
			...data.rides.map((ride) => ({
				id: `cycling:${selected[0].id}:ride:${ride.id}`,
				title: ride.startTime,
				url: "",
				snippet:
					ride.distanceMeters === null
						? ride.startTime
						: `${ride.distanceMeters} m`,
				sourceType: "tool" as const,
			})),
		];
		const protectedData = JSON.stringify({
			bikes: data.bikes,
			rides: data.rides,
			summary: data.summary,
			syncedAt: data.syncedAt,
			complete: data.complete,
		});
		const outcome = {
			modelPayload: fresh ? data : withReasonCode(data, "cached_rider_data"),
			candidates,
		};
		const redact = (message: string) => ({
			candidates: [],
			modelPayload: {
				...base,
				success: true,
				fresh,
				syncedAt: data.syncedAt,
				complete: data.complete,
				message: fresh ? message : `${data.message} ${message}`,
			},
		});
		return await applyLocalDistillGate({
			outcome,
			userId,
			modelId,
			capability: "cycling",
			userQuestion: [input.action, input.start, input.end]
				.filter(Boolean)
				.join(" "),
			rawText: protectedData,
			onDistilled: (_o, s) =>
				redact(
					s +
						(data.complete ? "" : " Only part of the ride history was synced."),
				),
			onUnavailable: () =>
				redact(
					"Cycling details were withheld because private summarization was unavailable.",
				),
		});
	} catch {
		return fail(
			"account_unreachable",
			"The rider's saved data could not be read.",
		);
	}
}
