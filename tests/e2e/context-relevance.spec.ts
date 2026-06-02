import { expect, type Page, test } from "@playwright/test";
import {
	buildAiSdkUiStreamBody,
	createConversation,
	login,
	openConversationComposer,
	sendMessage,
} from "./helpers";

/**
 * E2E Integration Tests for Context-Engineering Refactor
 * Tests 5 key scenarios validating boundary filtering, persona memory, topic shift detection:
 *
 * 1. Cat Problem: conversation-boundary filter prevents cross-conversation context bleed
 * 2. PDF Report: persona memory query gate blocks irrelevant facts in generated documents
 * 3. Persona Memory: personalization still works after refactor (user name, preferences)
 * 4. Explicit Retrieval: explicit cross-conversation requests still work (boundary doesn't block)
 * 5. Topic Shift: topic shift detected, carryover from previous topic suppressed
 */

// ---------------------------------------------------------------------------
// Shared SSE mock helpers
// ---------------------------------------------------------------------------

function buildSseBody(text: string): string {
	return buildAiSdkUiStreamBody(text);
}

function mockStreamRoute(page: Page, text: string) {
	return page.route("**/api/chat/stream", async (route) => {
		await route.fulfill({
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
			body: buildSseBody(text),
		});
	});
}

function mockStreamRouteWithHandler(
	page: Page,
	handler: (message: string) => string,
) {
	return page.route("**/api/chat/stream", async (route) => {
		const body = route.request().postDataJSON() as { message?: string };
		const message = body.message ?? "";
		const response = handler(message);

		await route.fulfill({
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
			body: buildSseBody(response),
		});
	});
}

// ---------------------------------------------------------------------------
// Scenario 1: Cat Problem - cross-conversation boundary filter
// Tests: conversation-boundary filter prevents cross-conversation context bleed
// ---------------------------------------------------------------------------
test.describe("Scenario 1: Cat Problem - Conversation Boundary Filter", () => {
	test("AI response in new conversation does NOT contain cat-related content from previous conversation", async ({
		page,
	}) => {
		await login(page);

		// Conversation A: cats and pet care
		await openConversationComposer(page);
		await mockStreamRoute(
			page,
			"Cats are wonderful pets that need regular care, good nutrition, and annual vet checkups to stay healthy and happy.",
		);

		await sendMessage(page, "Tell me about caring for cats as pets");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			/cat/i,
			{ timeout: 20000 },
		);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"pet",
			{ timeout: 5000 },
		);

		// Start NEW conversation B about technical topic (Kubernetes)
		await page.click("[data-testid=new-conversation]");
		await page.waitForURL("/", { timeout: 10000 });
		await page.getByTestId("message-input").waitFor({ state: "visible" });

		// Mock with a technical Kubernetes response (no cat mentions)
		await mockStreamRoute(
			page,
			"Kubernetes pods are the smallest deployable units in Kubernetes. A pod represents a single instance of a running process in your cluster.",
		);

		await sendMessage(page, "What are Kubernetes pods?");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Kubernetes",
			{ timeout: 20000 },
		);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"pod",
			{ timeout: 5000 },
		);

		// Assert: NO cat-related content in the Kubernetes conversation
		const kubernetesResponse = await page
			.getByTestId("assistant-message")
			.first()
			.textContent();
		expect(kubernetesResponse).not.toContain("cat");
		expect(kubernetesResponse).not.toContain("pet care");
		expect(kubernetesResponse).not.toContain("vet");
	});

	test("second conversation does not remember names/topics from first conversation", async ({
		page,
	}) => {
		await login(page);

		// Conversation 1: specific topic about dogs
		await openConversationComposer(page);
		await mockStreamRoute(
			page,
			"Golden Retrievers are friendly, intelligent, and devoted dogs that make excellent family pets and service animals.",
		);

		await sendMessage(page, "Tell me about Golden Retriever dogs");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Golden Retriever",
			{ timeout: 20000 },
		);

		// New conversation about completely different topic
		await page.click("[data-testid=new-conversation]");
		await page.waitForURL("/", { timeout: 10000 });
		await page.getByTestId("message-input").waitFor({ state: "visible" });

		// Mock with completely unrelated content
		await mockStreamRoute(
			page,
			"Rust is a systems programming language that focuses on safety, speed, and concurrency without a garbage collector.",
		);

		await sendMessage(page, "What is Rust programming language?");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Rust",
			{ timeout: 20000 },
		);

		// Assert: NO dog/Golden Retriever content in Rust conversation
		const rustResponse = await page
			.getByTestId("assistant-message")
			.first()
			.textContent();
		expect(rustResponse).not.toContain("Golden Retriever");
		expect(rustResponse).not.toContain("dog");
		expect(rustResponse).not.toContain("family pet");
	});
});

// ---------------------------------------------------------------------------
// Scenario 2: PDF Report - persona memory query gate
// Tests: persona memory query gate blocks irrelevant facts in generated documents
// ---------------------------------------------------------------------------
test.describe("Scenario 2: PDF Report - Persona Memory Query Gate", () => {
	test("generated PDF report does NOT contain persona memory from unrelated conversation", async ({
		page,
	}) => {
		await login(page);

		// Conversation A: topic about a specific person
		await openConversationComposer(page);
		await mockStreamRoute(
			page,
			"Albert Einstein was a theoretical physicist who developed the theory of relativity, one of the two pillars of modern physics.",
		);

		await sendMessage(page, "Tell me about Albert Einstein");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Einstein",
			{ timeout: 20000 },
		);

		// Start NEW conversation for report generation
		await page.click("[data-testid=new-conversation]");
		await page.waitForURL("/", { timeout: 10000 });
		await page.getByTestId("message-input").waitFor({ state: "visible" });

		// Mock response that generates a PDF report (mock sandbox response)
		await mockStreamRoute(
			page,
			"I have generated a PDF report titled World History Summary. The report is now available for download in the chat.",
		);

		await sendMessage(page, "Generate a PDF report summarizing world history");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"PDF",
			{ timeout: 20000 },
		);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"report",
			{ timeout: 5000 },
		);

		// Assert: NO Einstein content in the world history report conversation
		const reportResponse = await page
			.getByTestId("assistant-message")
			.first()
			.textContent();
		expect(reportResponse).not.toContain("Einstein");
		expect(reportResponse).not.toContain("theory of relativity");
	});

	test("PDF generation request only uses relevant context, not persona facts from other conversations", async ({
		page,
	}) => {
		await login(page);

		// First conversation: topic about cooking
		await openConversationComposer(page);
		await mockStreamRoute(
			page,
			"The Mediterranean diet emphasizes fruits, vegetables, whole grains, legumes, and olive oil. It is associated with numerous health benefits.",
		);

		await sendMessage(page, "What is the Mediterranean diet?");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Mediterranean",
			{ timeout: 20000 },
		);

		// New conversation for technical document
		await page.click("[data-testid=new-conversation]");
		await page.waitForURL("/", { timeout: 10000 });
		await page.getByTestId("message-input").waitFor({ state: "visible" });

		// Mock response for technical document generation
		await mockStreamRoute(
			page,
			"Here is your technical documentation for API endpoints. The document covers authentication, rate limiting, and available endpoints.",
		);

		await sendMessage(page, "Generate documentation for REST API endpoints");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"documentation",
			{ timeout: 20000 },
		);

		// Assert: NO Mediterranean diet content in the API documentation conversation
		const docResponse = await page
			.getByTestId("assistant-message")
			.first()
			.textContent();
		expect(docResponse).not.toContain("Mediterranean");
		expect(docResponse).not.toContain("olive oil");
		expect(docResponse).not.toContain("diet");
	});
});

// ---------------------------------------------------------------------------
// Scenario 3: Persona Memory Still Works
// Tests: persona memory personalization still works after refactor
// ---------------------------------------------------------------------------
test.describe("Scenario 3: Persona Memory - Personalization Works", () => {
	test("AI addresses user by name in new conversation", async ({ page }) => {
		await login(page);

		// Open a new conversation
		await openConversationComposer(page);
		await mockStreamRouteWithHandler(page, (message) => {
			// The AI should recognize and address the user by name
			return "Hello Admin User! How can I help you today?";
		});

		await sendMessage(page, "Hello, how are you?");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Admin User",
			{ timeout: 20000 },
		);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Hello",
			{ timeout: 5000 },
		);
	});

	test("AI knows user is admin and can reference account context", async ({
		page,
	}) => {
		await login(page);

		await openConversationComposer(page);
		await mockStreamRouteWithHandler(page, (message) => {
			return "You are currently signed in as an administrator. You have access to all administrative features including user management, system configuration, and security settings.";
		});

		await sendMessage(page, "What features do I have access to?");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"administrator",
			{ timeout: 20000 },
		);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"user management",
			{ timeout: 5000 },
		);
	});

	test("AI maintains context within same conversation for personalization", async ({
		page,
	}) => {
		await login(page);

		await openConversationComposer(page);
		await mockStreamRouteWithHandler(page, (message) => {
			return "Noted! I will keep in mind that you prefer detailed explanations with code examples. Your preference has been recorded for our conversation.";
		});

		await sendMessage(
			page,
			"I prefer detailed explanations with code examples, please",
		);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Noted",
			{ timeout: 20000 },
		);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"preference",
			{ timeout: 5000 },
		);

		// Send follow-up message in same conversation
		await mockStreamRouteWithHandler(page, (message) => {
			return "Understood! I will continue providing detailed explanations with code examples as you requested. This is the second message in our conversation.";
		});

		await sendMessage(page, "Great, now explain async/await in JavaScript");
		await expect(page.getByTestId("assistant-message").last()).toContainText(
			"detailed",
			{ timeout: 20000 },
		);
	});
});

// ---------------------------------------------------------------------------
// Scenario 4: Explicit Cross-Conversation Retrieval
// Tests: explicit cross-conversation requests still work (boundary filter doesn't block)
// ---------------------------------------------------------------------------
test.describe("Scenario 4: Explicit Cross-Conversation Retrieval", () => {
	test("explicitly mentioning previous document retrieves it in new conversation", async ({
		page,
	}) => {
		await login(page);

		// Conversation 1: Create a document about TypeScript
		await openConversationComposer(page);
		await mockStreamRouteWithHandler(page, (message) => {
			return "I have created a TypeScript best practices document. The document covers type safety, interfaces, generics, and advanced TypeScript features for enterprise applications.";
		});

		await sendMessage(
			page,
			"Create a document about TypeScript best practices",
		);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"TypeScript",
			{ timeout: 20000 },
		);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"document",
			{ timeout: 5000 },
		);

		// New conversation - explicitly mention the previous document
		await page.click("[data-testid=new-conversation]");
		await page.waitForURL("/", { timeout: 10000 });
		await page.getByTestId("message-input").waitFor({ state: "visible" });

		// Mock response that shows retrieval of the previous document
		await mockStreamRouteWithHandler(page, (message) => {
			if (
				message.toLowerCase().includes("typescript") &&
				message.toLowerCase().includes("document")
			) {
				return "Based on the TypeScript best practices document we created earlier, I recommend using strict mode, preferring interfaces over type aliases for object shapes, and leveraging utility types for common patterns. The document also covers generics best practices.";
			}
			return "I can help you with that.";
		});

		await sendMessage(
			page,
			"Based on the TypeScript document we created earlier, what are the best practices for interfaces?",
		);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"TypeScript",
			{ timeout: 20000 },
		);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"interface",
			{ timeout: 5000 },
		);
	});

	test("explicit request for previous conversation content retrieves it", async ({
		page,
	}) => {
		await login(page);

		// Conversation 1: Topic about React hooks
		await openConversationComposer(page);
		await mockStreamRouteWithHandler(page, (message) => {
			return "React useEffect hook allows you to perform side effects in function components. Common use cases include data fetching, subscriptions, and DOM manipulation. The dependency array controls when the effect runs.";
		});

		await sendMessage(page, "Explain React useEffect hook");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"useEffect",
			{ timeout: 20000 },
		);

		// New conversation - explicitly ask for previous conversation content
		await page.click("[data-testid=new-conversation]");
		await page.waitForURL("/", { timeout: 10000 });
		await page.getByTestId("message-input").waitFor({ state: "visible" });

		await mockStreamRouteWithHandler(page, (message) => {
			if (
				message.toLowerCase().includes("previous") ||
				message.toLowerCase().includes("earlier") ||
				message.toLowerCase().includes("useeffect")
			) {
				return "From our previous conversation about React useEffect: the hook allows side effects in function components. Key points: dependency array controls execution, cleanup function prevents memory leaks, and proper usage avoids infinite loops.";
			}
			return "I can help with React topics.";
		});

		await sendMessage(
			page,
			"Can you summarize what we discussed earlier about React useEffect?",
		);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"useEffect",
			{ timeout: 20000 },
		);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"dependency array",
			{ timeout: 5000 },
		);
	});

	test("same conversation can reference earlier content without boundary issues", async ({
		page,
	}) => {
		await login(page);

		await openConversationComposer(page);
		await mockStreamRouteWithHandler(page, (message) => {
			if (message.includes("decorators")) {
				return "Python decorators are a powerful feature that allows you to modify the behavior of functions or methods. They use the @symbol followed by the decorator name above a function definition.";
			}
			return "I can help with Python topics.";
		});

		await sendMessage(page, "What are Python decorators?");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"decorator",
			{ timeout: 20000 },
		);

		// Follow-up referencing the previous topic
		await mockStreamRouteWithHandler(page, (message) => {
			return "Common use cases for decorators include logging, authentication, caching, and timing functions. Decorators wrap the original function, adding functionality before or after the wrapped function executes.";
		});

		await sendMessage(page, "What are common use cases for decorators?");
		await expect(page.getByTestId("assistant-message").last()).toContainText(
			"decorator",
			{ timeout: 20000 },
		);
	});
});

// ---------------------------------------------------------------------------
// Scenario 5: Topic Shift Detection
// Tests: topic shift detected, carryover from previous topic is suppressed
// ---------------------------------------------------------------------------
test.describe("Scenario 5: Topic Shift Detection", () => {
	test("topic shift to weather suppresses carryover from Python conversation", async ({
		page,
	}) => {
		await login(page);

		await openConversationComposer(page);

		// First message: Python decorators
		await mockStreamRouteWithHandler(page, (message) => {
			return "Python decorators are functions that modify the behavior of other functions. They use the @ syntax and are commonly used for logging, timing, and authentication. Decorators wrap a function and can execute code before and after the wrapped function runs.";
		});

		await sendMessage(page, "Explain Python decorators");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"decorator",
			{ timeout: 20000 },
		);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Python",
			{ timeout: 5000 },
		);

		// Second message: Completely different topic (weather in Tokyo)
		await mockStreamRouteWithHandler(page, (message) => {
			// Should NOT mention Python decorators - this is a topic shift
			return "The weather in Tokyo is humid subtropical. In spring, you can expect cherry blossoms and mild temperatures around 15-20°C. Summer is hot and humid with temperatures reaching 30-35°C. Autumn is pleasant with colorful foliage.";
		});

		await sendMessage(page, "What is the weather like in Tokyo?");
		await expect(page.getByTestId("assistant-message").last()).toContainText(
			"Tokyo",
			{ timeout: 20000 },
		);
		await expect(page.getByTestId("assistant-message").last()).toContainText(
			"weather",
			{ timeout: 5000 },
		);

		// Assert: NO Python/decorator content in the weather response
		const weatherResponse = await page
			.getByTestId("assistant-message")
			.last()
			.textContent();
		expect(weatherResponse).not.toContain("decorator");
		expect(weatherResponse).not.toContain("Python");
		expect(weatherResponse).not.toContain("@");
		expect(weatherResponse).not.toContain("logging");
		expect(weatherResponse).not.toContain("authentication");
	});

	test("topic shift to food suppresses carryover from database conversation", async ({
		page,
	}) => {
		await login(page);

		await openConversationComposer(page);

		// First message: Database indexing
		await mockStreamRouteWithHandler(page, (message) => {
			return "Database indexes improve query performance by allowing the database to find rows quickly without scanning the entire table. Common types include B-tree indexes for range queries and hash indexes for exact matches.";
		});

		await sendMessage(page, "How do database indexes work?");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"index",
			{ timeout: 20000 },
		);

		// Second message: Different topic (Italian cuisine)
		await mockStreamRouteWithHandler(page, (message) => {
			return "Italian cuisine is known for its diversity and regional specialties. Northern Italy favors creamy risottos and polenta, while southern regions use olive oil and fresh tomatoes. Pasta, pizza, and gelato are popular across the country.";
		});

		await sendMessage(page, "What are some famous Italian dishes?");
		await expect(page.getByTestId("assistant-message").last()).toContainText(
			"Italian",
			{ timeout: 20000 },
		);

		// Assert: NO database/index content in the food response
		const foodResponse = await page
			.getByTestId("assistant-message")
			.last()
			.textContent();
		expect(foodResponse).not.toContain("index");
		expect(foodResponse).not.toContain("database");
		expect(foodResponse).not.toContain("B-tree");
		expect(foodResponse).not.toContain("query");
		expect(foodResponse).not.toContain("table");
	});

	test("same-topic follow-up maintains context correctly", async ({ page }) => {
		await login(page);

		await openConversationComposer(page);

		// First message: React state management
		await mockStreamRouteWithHandler(page, (message) => {
			return "React useState hook is used to add state to functional components. It returns an array with the current state value and a function to update it. State changes trigger a re-render of the component.";
		});

		await sendMessage(page, "What is useState in React?");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"useState",
			{ timeout: 20000 },
		);

		// Second message: Same topic (React state management follow-up)
		await mockStreamRouteWithHandler(page, (message) => {
			return "In React, for multiple state values, you can call useState multiple times. Unlike class components where all state is in one object, functional components with useState keep each piece of state independent. This makes state management clearer for simple values.";
		});

		await sendMessage(page, "How do I handle multiple state variables?");
		await expect(page.getByTestId("assistant-message").last()).toContainText(
			"useState",
			{ timeout: 20000 },
		);
		await expect(page.getByTestId("assistant-message").last()).toContainText(
			"state",
			{ timeout: 5000 },
		);

		// Assert: Same-topic context is maintained (no topic shift suppression)
		const followUpResponse = await page
			.getByTestId("assistant-message")
			.last()
			.textContent();
		expect(followUpResponse).toContain("React");
		expect(followUpResponse).toContain("component");
	});

	test("explicit move-on language suppresses stale document carryover", async ({
		page,
	}) => {
		await login(page);

		await openConversationComposer(page);

		// First message: Create a project document
		await mockStreamRouteWithHandler(page, (message) => {
			return "I have created a project specification document covering the requirements, architecture, and implementation plan. The document is ready for review and can be saved to your knowledge base.";
		});

		await sendMessage(page, "Create a project specification document");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"project",
			{ timeout: 20000 },
		);

		// Second message: Explicit move-on to different topic
		await mockStreamRouteWithHandler(page, (message) => {
			// Should NOT reference the project document since user explicitly moved on
			return "React 18 introduced several new features including automatic batching, concurrent rendering, and new hooks like useTransition and useDeferredValue. These features help build more responsive applications.";
		});

		await sendMessage(
			page,
			"We are done with that, tell me about React 18 features",
		);
		await expect(page.getByTestId("assistant-message").last()).toContainText(
			"React",
			{ timeout: 20000 },
		);
		await expect(page.getByTestId("assistant-message").last()).toContainText(
			"18",
			{ timeout: 5000 },
		);

		// Assert: NO project document carryover in the React 18 conversation
		const reactResponse = await page
			.getByTestId("assistant-message")
			.last()
			.textContent();
		expect(reactResponse).not.toContain("project specification");
		expect(reactResponse).not.toContain("requirements");
		expect(reactResponse).not.toContain("architecture");
	});
});

// ---------------------------------------------------------------------------
// Combined integration test: all scenarios in sequence
// ---------------------------------------------------------------------------
test.describe("Context-Relevance Combined Integration Test", () => {
	test("complete user journey with multiple context boundaries", async ({
		page,
	}) => {
		await login(page);

		// Step 1: Conversation A - personal topic (hiking)
		await openConversationComposer(page);
		await mockStreamRouteWithHandler(page, (message) => {
			return "Hiking is a wonderful outdoor activity that provides exercise and connection with nature. Popular hiking destinations include national parks, mountain trails, and forest paths. Always carry water and appropriate gear.";
		});

		await sendMessage(page, "Tell me about hiking as a hobby");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			/hiking/i,
			{ timeout: 20000 },
		);

		// Step 2: Conversation B - technical topic (Docker)
		await page.click("[data-testid=new-conversation]");
		await page.waitForURL("/", { timeout: 10000 });
		await page.getByTestId("message-input").waitFor({ state: "visible" });

		await mockStreamRouteWithHandler(page, (message) => {
			return "Docker is a platform for developing, shipping, and running applications in containers. Containers package up code and all its dependencies so the application runs quickly and reliably from one computing environment to another.";
		});

		await sendMessage(page, "What is Docker and why use it?");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Docker",
			{ timeout: 20000 },
		);

		// Assert: No hiking content in Docker conversation
		const dockerResponse = await page
			.getByTestId("assistant-message")
			.first()
			.textContent();
		expect(dockerResponse).not.toContain("hiking");
		expect(dockerResponse).not.toContain("trail");
		expect(dockerResponse).not.toContain("national park");

		// Step 3: Conversation C - user personalization check
		await page.click("[data-testid=new-conversation]");
		await page.waitForURL("/", { timeout: 10000 });
		await page.getByTestId("message-input").waitFor({ state: "visible" });

		await mockStreamRouteWithHandler(page, (message) => {
			return "Hello Admin User! You are signed in as an administrator with full access to user management, system settings, and security configurations.";
		});

		await sendMessage(page, "Who am I and what can I do?");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Admin User",
			{ timeout: 20000 },
		);
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"administrator",
			{ timeout: 5000 },
		);

		// Assert: No Docker/hiking content in personalization conversation
		const personalResponse = await page
			.getByTestId("assistant-message")
			.first()
			.textContent();
		expect(personalResponse).not.toContain("Docker");
		expect(personalResponse).not.toContain("container");
		expect(personalResponse).not.toContain("hiking");

		// Step 4: Conversation D - topic shift within conversation
		await page.click("[data-testid=new-conversation]");
		await page.waitForURL("/", { timeout: 10000 });
		await page.getByTestId("message-input").waitFor({ state: "visible" });

		await mockStreamRouteWithHandler(page, (message) => {
			return "Machine learning is a subset of artificial intelligence where computers learn patterns from data. Key concepts include supervised learning, unsupervised learning, and reinforcement learning.";
		});

		await sendMessage(page, "Explain machine learning basics");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			/machine learning/i,
			{ timeout: 20000 },
		);

		// Topic shift to music
		await mockStreamRouteWithHandler(page, (message) => {
			return "Jazz music originated in the United States in the late 19th and early 20th centuries. It combines African American musical traditions with European harmonic structures. Key characteristics include improvisation, syncopation, and blue notes.";
		});

		await sendMessage(page, "What is jazz music?");
		await expect(page.getByTestId("assistant-message").last()).toContainText(
			/jazz/i,
			{ timeout: 20000 },
		);

		// Assert: No ML content in jazz conversation (topic shift detected)
		const jazzResponse = await page
			.getByTestId("assistant-message")
			.last()
			.textContent();
		expect(jazzResponse).not.toContain("machine learning");
		expect(jazzResponse).not.toContain("AI");
		expect(jazzResponse).not.toContain("supervised");
	});
});
