import type { Request, Response } from "express";
import * as express from "express";

// Create express router
const router = express.Router();

// Configuration from environment variables
const MOCK_TITLE_DELAY_MS = parseInt(
	process.env.MOCK_TITLE_DELAY_MS || "50",
	10,
);
const MOCK_TITLE_RESPONSE =
	process.env.MOCK_TITLE_RESPONSE || "Mock Title For Conversation";

/**
 * Simulate delay
 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Handle POST requests to /v1/chat/completions for title generation
 */
router.post("/v1/chat/completions", async (req: Request, res: Response) => {
	// Log request for debugging
	console.log("[Mock Nemotron] Received request to /v1/chat/completions");
	console.log("[Mock Nemotron] Body:", JSON.stringify(req.body, null, 2));

	// Validate Authorization header
	const authHeader = req.headers.authorization;
	if (!authHeader?.startsWith("Bearer ")) {
		console.log("[Mock Nemotron] Missing or invalid Authorization header");
		return res
			.status(401)
			.json({ error: "Missing or invalid Authorization header" });
	}

	// Handle error modes
	if (process.env.MOCK_ERROR_MODE === "500") {
		console.log("[Mock Nemotron] Simulating 500 error");
		return res.status(500).json({ error: "Internal server error" });
	}

	if (process.env.MOCK_ERROR_MODE === "timeout") {
		console.log("[Mock Nemotron] Simulating timeout");
		// Never respond - simulate timeout
		return;
	}

	// Simulate delay
	await delay(MOCK_TITLE_DELAY_MS);

	// Construct OpenAI-compatible response
	const response = {
		id: `chatcmpl-mock-${Date.now()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: "mock-nemotron-model",
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: MOCK_TITLE_RESPONSE,
				},
				finish_reason: "stop",
			},
		],
		usage: {
			prompt_tokens: 10,
			completion_tokens: 5,
			total_tokens: 15,
		},
	};

	res.json(response);
});

export default router;
