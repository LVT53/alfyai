/**
 * The sandbox an HTML preview's frame is drawn with. A static file gets none of
 * the frame's powers; a standard report (served with its trusted runtime) may run
 * its own scripts and open links in a new tab.
 *
 * Never `allow-same-origin`, for either. Next to `allow-scripts` it would let a
 * script in the frame lift its own sandbox and act as the app; read aloud's report
 * bridge (`$lib/client/read-aloud/report-bridge.ts`) relies on the frame staying
 * opaque and talks to it by `postMessage` alone. Held by `html-sandbox.test.ts`.
 */
export function htmlPreviewSandbox(trustedRuntime: boolean): string {
	return trustedRuntime
		? "allow-scripts allow-popups allow-popups-to-escape-sandbox"
		: "";
}
