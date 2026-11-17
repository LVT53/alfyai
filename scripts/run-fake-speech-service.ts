// Runs the fake speech service on a port, for manual checks of read aloud
// without the GPU box (Plan 2, Task 3):
//
//   npx tsx scripts/run-fake-speech-service.ts [--port 1929]
//
// Then set TTS_URL=http://127.0.0.1:1929 and TTS_ENABLED=true in the System
// pane. It speaks silence (MP3 frames of the right length) and sends the
// timeline of Plan 1's contract; it runs until Ctrl-C.

import { createFakeSpeechService } from "../src/lib/server/services/read-aloud/testing/fake-speech-service";

function portFromArguments(args: string[]): number {
	const flag = args.indexOf("--port");
	if (flag === -1) return 1929;
	const port = Number(args[flag + 1]);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		console.error("--port needs a port from 1 to 65535");
		process.exit(2);
	}
	return port;
}

const fake = await createFakeSpeechService(
	{},
	{ port: portFromArguments(process.argv.slice(2)) },
);
console.log(`fake speech service on ${fake.baseUrl} (Ctrl-C stops it)`);

process.on("SIGINT", () => {
	void fake.close().then(() => process.exit(0));
});
