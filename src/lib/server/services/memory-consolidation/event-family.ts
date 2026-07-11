import type { MemoryReworkTelemetryFamily } from "../memory-profile/types";

/**
 * Every telemetry breadcrumb the night shift files — the consolidation run
 * result, the reconcile-call failure, and the persona-summary failure — belongs
 * to ONE event family so the whole night shift reads as one thing in telemetry.
 *
 * That family is "maintenance": the three call sites already used it
 * independently, and the existing telemetry assertions (steps.test.ts,
 * summary.test.ts) pin it. Routing all three through this one constant keeps them
 * from drifting apart without re-tagging anything, so those assertions stay green.
 */
export const NIGHT_SHIFT_EVENT_FAMILY: MemoryReworkTelemetryFamily =
	"maintenance";
