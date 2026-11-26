import { JsonReporter } from "vitest/node";

export default class GateVitestReporter extends JsonReporter {
	constructor() {
		super({ outputFile: process.env.ALFYAI_VITEST_REPORT });
	}

	async onTestRunEnd(...args) {
		try {
			await super.onTestRunEnd(...args);
		} catch (error) {
			console.warn(`Vitest timings unavailable: ${error.message}`);
		}
	}
}
