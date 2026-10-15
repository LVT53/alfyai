// What an attempt is told when the engine takes it back, by reason.
//
// A leaf, because two files need it that must not import each other: the kind's
// definition (`production-job.ts`) names these words as its `lostAttempt`, and the
// handler (`production-runner.ts`, which the definition loads on the first claim)
// uses the stale one for an error nobody mapped.

import type { TakeBackReason } from "$lib/server/services/jobs";

const STALE_WORKER_MESSAGE = "File production worker stopped before finishing.";
const RESTART_MESSAGE = "File production stopped when the server restarted.";
const STATE_LOST_MESSAGE =
	"File production worker state was lost before finishing.";

export function lostFileProductionAttempt(reason: TakeBackReason): {
	code: string;
	message: string;
} {
	switch (reason) {
		case "state-lost":
			return { code: "worker_state_lost", message: STATE_LOST_MESSAGE };
		case "dead-worker":
			return { code: "worker_heartbeat_timeout", message: RESTART_MESSAGE };
		default:
			return {
				code: "worker_heartbeat_timeout",
				message: STALE_WORKER_MESSAGE,
			};
	}
}
