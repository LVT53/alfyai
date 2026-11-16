/**
 * The error a tool throws to turn a call down BEFORE it has dispatched anything:
 * the call's own address or id failed a check the tool runs ahead of its work (an
 * address that came from neither the user nor a tool, an id outside the scope the
 * tool may read). Nothing ran, so the tool envelope records the call as
 * `definitely_not_executed` and the turn goes on: the model reads the refusal,
 * which is written for it, and can correct itself.
 *
 * A thrown error of any other kind is `uncertain` (a throw alone cannot prove
 * that nothing ran, and the engine stops the turn at an uncertain call), unless
 * it comes from a tool that says it only reads (`readOnly` on its envelope call),
 * where it is a settled failure. So throw this only from a check that runs
 * before the work starts, never from code that may already have dispatched it.
 * Pure: no I/O, no state.
 */
export class ToolCallRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolCallRefusedError";
	}
}
