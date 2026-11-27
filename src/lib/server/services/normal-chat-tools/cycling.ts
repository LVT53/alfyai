import { z } from "zod";
import type { ToolReasonCode } from "$lib/shared/tool-reasons";
import {
	loadBoschDetailForQuestion,
	loadBoschForQuestion,
	type readBoschSnapshot,
} from "../connections/providers/bosch-flow-bridge";
import {
	type BoschDetailResult,
	boschDetailActions,
	parseBoschDetailQuery,
} from "../connections/providers/bosch-flow-details";
import {
	matchingConnections,
	resolveConnectionsForCapability,
} from "../connections/resolve";
import type { ToolEvidenceCandidate } from "../message-evidence";
import { applyLocalDistillGate } from "./connector-distill";
import { withReasonCode } from "./shared";

export const cyclingToolInputSchema = z.object({
	action: z.enum(["bikes", "rides", "summary", ...boschDetailActions]),
	account: z.string().trim().optional(),
	start: z.iso.datetime({ offset: true }).optional(),
	end: z.iso.datetime({ offset: true }).optional(),
	limit: z.number().int().min(1).max(50).optional(),
	offset: z.number().int().min(0).max(2000000).optional(),
	id: z
		.string()
		.max(150)
		.optional()
		.describe(
			"Selected Bosch bike or ride ID from bikes or rides; required for detailed reads.",
		),
	field: z
		.string()
		.max(240)
		.optional()
		.describe(
			"Optional exact field or prefix, e.g. driveUnit.odometer or batteries.0.",
		),
	textOffset: z
		.number()
		.int()
		.min(0)
		.max(12 * 1024 * 1024)
		.optional()
		.describe(
			"For a long text value, pass its exact field and nextTextOffset here.",
		),
	batteryIndex: z
		.number()
		.int()
		.min(0)
		.max(49)
		.optional()
		.describe(
			"Battery shown on bike_profile, default 0; battery_capacity only.",
		),
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
	detail?: BoschDetailResult;
	units?: Record<string, string>;
	summary: {
		rideCount: number;
		distanceMeters: number;
		ridesWithoutDistance: number;
	} | null;
	citations: { label: string; url: string }[];
};
// Documented units in Bosch Data Act Appendix 1. Omit units Bosch doesn't state.
const fieldUnits: Record<string, string> = {
	"driveUnit.odometer": "m",
	"driveUnit.maximumAssistanceSpeed": "km/h",
	"driveUnit.walkAssistConfiguration.maximumSpeed": "km/h",
	"driveUnit.activeAssistModes[].reachableRange": "m",
	"driveUnit.rearWheelCircumferenceUser": "mm",
	"driveUnit.powerOnTime.total": "h",
	"driveUnit.powerOnTime.withMotorSupport": "h",
	"batteries[].deliveredWhOverLifetime": "Wh",
	"serviceDue.odometer": "m",
	startOdometer: "m",
	distance: "m",
	durationWithoutStops: "s",
	"speed.average": "km/h",
	"speed.maximum": "km/h",
	"elevation.gain": "m",
	"elevation.loss": "m",
	"cadence.average": "rpm",
	"cadence.maximum": "rpm",
	"riderPower.average": "W",
	"riderPower.maximum": "W",
	"activityDetails[].distance": "m",
	"activityDetails[].altitude": "m",
	"activityDetails[].speed": "km/h",
	"activityDetails[].latitude": "degrees WGS84",
	"activityDetails[].longitude": "degrees WGS84",
	"activityDetails[].cadence": "rpm",
	"activityDetails[].riderPower": "W",
	"capacityTesters[].batteryData.measuredCapacity": "Wh",
	"capacityTesters[].batteryData.nominalCapacity": "Wh",
};
function unitsIn(result: BoschDetailResult) {
	const units: Record<string, string> = {};
	for (const field of result.fields) {
		const key = field.path.replace(/\.\d+(?=\.|$)/g, "[]");
		if (typeof field.value === "number" && Object.hasOwn(fieldUnits, key))
			units[key] = fieldUnits[key];
	}
	return units;
}

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
	const fail = (reason: ToolReasonCode<"cycling">, message: string) => ({
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
					: "No active cycling connection is available for this turn. Check Bosch eBike Flow in Settings > Connections.",
			);
		if (
			input.action !== "bikes" &&
			input.action !== "rides" &&
			input.action !== "summary"
		) {
			const query = parseBoschDetailQuery({
				action: input.action,
				id: input.id,
				offset: input.offset,
				field: input.field,
				textOffset: input.textOffset,
				batteryIndex: input.batteryIndex,
			});
			if (!query || input.start || input.end || input.limit)
				return fail(
					"not_supported",
					"Select a valid detail field and bike or ride ID. Use offset only to continue a detail result.",
				);
			const answer = await loadBoschDetailForQuestion(
				userId,
				selected[0].id,
				query,
			);
			if (answer.status === "consent_required")
				return fail(
					"detail_consent_required",
					"Ask the rider to check their Bosch data permissions in Settings > Connections, or in their existing private helper.",
				);
			if (answer.status === "access_denied")
				return fail(
					"detail_access_denied",
					"Bosch denied access to the selected data. Ask the rider to check their app and per-bike permissions in Flow Manage Access. The missing value is unknown.",
				);
			if (answer.status === "not_found")
				return fail(
					"item_not_found",
					"No matching record was available for this bike, ride or test. This does not establish that the bike lacks the component or that a measurement is zero.",
				);
			if (answer.status !== "ready")
				return fail(
					"detail_unavailable",
					"The rider's helper could not provide these details now. No detail cache is available; do not infer a value.",
				);
			const data: Payload = {
				...base,
				success: true,
				fresh: true,
				syncedAt: new Date().toISOString(),
				complete:
					answer.result.nextOffset === null &&
					!answer.result.fields.some((f) => f.nextTextOffset !== undefined),
				nextOffset: answer.result.nextOffset,
				detail: answer.result,
				units: unitsIn(answer.result),
				message: answer.result.fields.length
					? "Read the requested Bosch fields. Numbers keep Bosch's units; do not assume a unit for an undocumented field. To continue long text, pass its exact field and nextTextOffset as textOffset. Use nextOffset when present to continue this same question."
					: "No matching fields were available. Dealer reports and battery measurements may never have been supplied. Do not infer a zero value, a missing component or an empty ride history.",
			};
			const redacted = (message: string) => ({
				modelPayload: {
					...base,
					success: true,
					fresh: true,
					syncedAt: data.syncedAt,
					complete: data.complete,
					nextOffset: data.nextOffset,
					message,
				},
				candidates: [] as ToolEvidenceCandidate[],
			});
			return await applyLocalDistillGate({
				outcome: {
					modelPayload: data,
					candidates: [] as ToolEvidenceCandidate[],
				},
				userId,
				modelId,
				capability: "cycling",
				userQuestion: [input.action, input.field].filter(Boolean).join(" "),
				rawText: answer.result.fields.length
					? JSON.stringify({ detail: answer.result, units: data.units })
					: "",
				onDistilled: (_o, summary) => redacted(summary),
				onUnavailable: () =>
					redacted(
						"The requested fields were withheld because private summarization was unavailable.",
					),
			});
		}
		if (
			input.id ||
			input.field ||
			input.batteryIndex !== undefined ||
			input.textOffset !== undefined ||
			(input.offset ?? 0) > 2000
		)
			return fail(
				"not_supported",
				"Use a detail action for an individual bike, ride or field.",
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

		// Check the original snapshot before applying a date range or pagination.
		if (!snapshot.bikes.length && !snapshot.rides.length) {
			return {
				modelPayload: withReasonCode(
					{
						...data,
						success: false,
						complete: false,
						message:
							data.message +
							" No bikes or rides were visible in this snapshot. Lifetime totals and ride history are unknown. Ask the rider to reopen Bosch Flow Data Act, choose Manage Access and switch on their own client under the bike, then ask again.",
					},
					"no_visible_rider_data",
				),
				candidates: [],
			};
		}
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
