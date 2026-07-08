import { describe, expect, it } from "vitest";
import * as activeContext from "./active-context";
import * as dirtyLedger from "./dirty-ledger";
import * as facade from "./index";
import * as projectionStore from "./projection-store";
import * as readModel from "./read-model";
import * as resetGeneration from "./reset-generation";
import * as review from "./review";
import * as telemetry from "./telemetry";

describe("memory profile facade", () => {
	it("keeps compatibility exports wired to internal seams", () => {
		expect(facade.getCurrentMemoryResetGeneration).toBe(
			resetGeneration.getCurrentMemoryResetGeneration,
		);
		expect(facade.createMemoryProfileItem).toBe(
			projectionStore.createMemoryProfileItem,
		);
		expect(facade.getMemoryProfileReadModel).toBe(
			readModel.getMemoryProfileReadModel,
		);
		expect(facade.getActiveMemoryProfileContext).toBe(
			activeContext.getActiveMemoryProfileContext,
		);
		expect(facade.recordMemoryReworkTelemetry).toBe(
			telemetry.recordMemoryReworkTelemetry,
		);
		expect(facade.createOrUpdateMemoryReviewItem).toBe(
			review.createOrUpdateMemoryReviewItem,
		);
		expect(facade.markMemoryDirty).toBe(dirtyLedger.markMemoryDirty);
	});
});
