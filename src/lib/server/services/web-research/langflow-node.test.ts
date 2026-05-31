import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const nodeSource = () =>
	readFileSync(
		resolve(process.cwd(), "langflow_nodes/web_research_tool.py"),
		"utf8",
	);

const runWebResearchNodeSuccessFixture = () => {
	const nodePath = resolve(
		process.cwd(),
		"langflow_nodes",
		"web_research_tool.py",
	);
	const script = `
import importlib.util
import json
import sys
import types

class Component:
    pass

class DummyInput:
    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs
        for key, value in kwargs.items():
            setattr(self, key, value)

class Output(DummyInput):
    pass

class Data:
    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs
        self.data = kwargs.get("data")
        self.text = kwargs.get("text", "")

class FakeResponse:
    status_code = 200
    headers = {"content-type": "application/json"}
    text = ""

    def json(self):
        return {
            "query": "current Framework X Pro price",
            "queries": [{"query": "current Framework X Pro price", "purpose": "broad"}],
            "sources": [
                {
                    "ref": "S1",
                    "id": "source-1",
                    "title": "Framework X Pro - Official Store",
                    "url": "https://example.com/products/x-pro",
                    "provider": "exa",
                    "authorityClass": "standard",
                    "authorityScore": 35,
                }
            ],
            "evidence": [
                {
                    "ref": "E1",
                    "id": "evidence-1",
                    "sourceRef": "S1",
                    "sourceId": "source-1",
                    "title": "Framework X Pro - Official Store",
                    "url": "https://example.com/products/x-pro",
                    "quote": "The current starting price is $799 before taxes and shipping.",
                    "score": 98,
                }
            ],
            "answerBrief": {
                "markdown": "Research brief for: current Framework X Pro price\\n\\nSources:\\n[S1] Framework X Pro - Official Store\\nURL: https://example.com/products/x-pro\\n\\nEvidence snippets:\\n[E1] The current starting price is $799 before taxes and shipping.",
                "instructions": ["Use only returned sources."],
                "sources": [],
                "evidence": [],
            },
			"diagnostics": {
				"mode": "exact",
				"freshness": "live",
				"sourcePolicy": "commerce",
				"providers": {
					"exaConfigured": True,
					"braveConfigured": True,
				},
				"selectedSourceCount": 1,
				"evidenceCandidateCount": 1,
				"providerCalls": [
					{
						"provider": "brave",
						"query": "current Framework X Pro price",
						"resultCount": 0,
						"latencyMs": 25,
						"error": "Brave search failed: 429 Too Many Requests",
					}
				],
			},
		}

def install_module(name, attrs=None):
    module = types.ModuleType(name)
    for key, value in (attrs or {}).items():
        setattr(module, key, value)
    sys.modules[name] = module
    return module

for name in [
    "lfx",
    "lfx.custom",
    "lfx.custom.custom_component",
    "lfx.custom.custom_component.component",
    "lfx.inputs",
    "lfx.inputs.inputs",
    "lfx.io",
    "lfx.log",
    "lfx.log.logger",
    "lfx.schema",
    "lfx.schema.data",
    "requests",
]:
    install_module(name)

sys.modules["lfx.custom.custom_component.component"].Component = Component
for attr in ["BoolInput", "DropdownInput", "IntInput", "StrInput"]:
    setattr(sys.modules["lfx.inputs.inputs"], attr, type(attr, (DummyInput,), {}))
sys.modules["lfx.io"].Output = Output
sys.modules["lfx.log.logger"].logger = types.SimpleNamespace(
    debug=lambda *args, **kwargs: None,
    info=lambda *args, **kwargs: None,
    warning=lambda *args, **kwargs: None,
    error=lambda *args, **kwargs: None,
)
sys.modules["lfx.schema.data"].Data = Data
sys.modules["requests"].exceptions = types.SimpleNamespace(
    Timeout=Exception,
    ConnectionError=Exception,
)
sys.modules["requests"].post = lambda *args, **kwargs: FakeResponse()

spec = importlib.util.spec_from_file_location("web_research_tool", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

component = module.WebResearchToolComponent()
component.alfyai_api_url = "http://alfyai.test"
component.alfyai_api_signing_key = ""
component.query = "current Framework X Pro price"
component.mode = "exact"
component.freshness = "live"
component.source_policy = "commerce"
component.max_sources = 4
component.quote_required = True
component.graph = types.SimpleNamespace(session_id="conv-1")

result = component.research_web()
print(json.dumps({
    "data": result.data,
    "text": result.text,
}, ensure_ascii=False, separators=(",", ":")))
`;

	return JSON.parse(
		execFileSync("python3", ["-c", script, nodePath], {
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
		}),
	) as {
		data: {
			success: boolean;
			answerBriefMarkdown?: string;
			sources?: Array<{ title?: string; url?: string }>;
			evidence?: Array<{ quote?: string }>;
			diagnostics?: {
				providers?: { exaConfigured?: boolean; braveConfigured?: boolean };
				providerErrors?: Array<{
					provider?: string;
					query?: string;
					error?: string;
				}>;
			};
		};
		text: string;
	};
};

describe("Langflow Web Research tool node", () => {
	it("exposes research_web as the model-facing tool contract", () => {
		const source = nodeSource();

		expect(source).toContain('display_name = "Web Research"');
		expect(source).toContain('name = "research_web"');
		expect(source).toContain('method="research_web"');
		expect(source).toContain("def research_web(self) -> Data:");
		expect(source).toContain("/api/tools/research-web");

		for (const field of [
			"query",
			"mode",
			"freshness",
			"source_policy",
			"quote_required",
		]) {
			expect(source).toContain(`name="${field}"`);
			expect(source).toMatch(
				new RegExp(`name="${field}"[\\s\\S]*?tool_mode=True`),
			);
		}

		expect(source).not.toMatch(/name="conversationId"/);
		expect(source).not.toMatch(/name="conversation_id"/);
	});

	it("returns a model-visible text payload when web research finds sources", () => {
		const result = runWebResearchNodeSuccessFixture();

		expect(result.data.success).toBe(true);
		expect(result.data.sources?.[0]?.title).toBe(
			"Framework X Pro - Official Store",
		);

		expect(result.text).not.toBe("");
		const textPayload = JSON.parse(result.text) as typeof result.data;
		expect(textPayload.success).toBe(true);
		expect(result.text).not.toContain("conv-1");
		expect(result.text).not.toContain("source-1");
		expect(result.text).not.toContain("evidence-1");
		expect(textPayload.answerBriefMarkdown).toContain("Research brief for");
		expect(textPayload.sources?.[0]?.url).toBe(
			"https://example.com/products/x-pro",
		);
		expect(textPayload.sources?.[0]).not.toHaveProperty("id");
		expect(textPayload.evidence?.[0]?.quote).toContain("$799");
		expect(textPayload.evidence?.[0]).not.toHaveProperty("id");
		expect(textPayload.evidence?.[0]).not.toHaveProperty("sourceId");
		expect(textPayload.diagnostics?.providers).toEqual({
			exaConfigured: true,
			braveConfigured: true,
		});
		expect(textPayload.diagnostics?.providerErrors?.[0]).toMatchObject({
			provider: "brave",
			query: "current Framework X Pro price",
			error: "Brave search failed: 429 Too Many Requests",
		});
	});
});
