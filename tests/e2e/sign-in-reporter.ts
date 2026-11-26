import { writeFileSync } from "node:fs";
import type { Reporter } from "@playwright/test/reporter";

export default class SignInReporter implements Reporter {
	private totalMs = 0;
	private outputFile: string;

	constructor({ outputFile }: { outputFile: string }) {
		this.outputFile = outputFile;
	}

	onStepEnd(...[, , step]: Parameters<NonNullable<Reporter["onStepEnd"]>>) {
		if (step.category === "test.step" && step.title.startsWith("sign in")) {
			this.totalMs += step.duration;
		}
	}

	onEnd() {
		try {
			writeFileSync(this.outputFile, JSON.stringify(this.totalMs));
		} catch (error) {
			console.warn(`Playwright sign-in timings unavailable: ${String(error)}`);
		}
	}
}
