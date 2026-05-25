import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const nodeSource = () =>
	readFileSync(
		resolve(process.cwd(), "langflow_nodes/file_production_tool.py"),
		"utf8",
	);

const runFileProductionNodeContractFixture = () => {
	const nodePath = resolve(
		process.cwd(),
		"langflow_nodes",
		"file_production_tool.py",
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
for attr in ["DictInput", "DropdownInput", "MultilineInput", "StrInput"]:
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
sys.modules["requests"].post = lambda *args, **kwargs: None

spec = importlib.util.spec_from_file_location("file_production_tool", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

component = module.FileProductionToolComponent
inputs = {
    getattr(input_field, "name", ""): {
        "inputType": input_field.__class__.__name__,
        "toolMode": getattr(input_field, "tool_mode", None),
        "info": getattr(input_field, "info", ""),
    }
    for input_field in component.inputs
}

print(json.dumps({
    "inputs": {
        "documentSource": inputs["documentSource"],
        "program": inputs["program"],
    },
    "parsedObject": component._parse_json_field({"title": "Report"}),
    "parsedArray": component._parse_json_field([{"type": "pdf"}]),
    "parsedJsonObject": component._parse_json_field('{"language":"python"}'),
}, ensure_ascii=False, separators=(",", ":")))
`;

	return JSON.parse(
		execFileSync("python3", ["-c", script, nodePath], {
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
		}),
	) as {
		inputs: Record<
			"documentSource" | "program",
			{ inputType: string; toolMode: boolean; info: string }
		>;
		parsedObject: { title: string };
		parsedArray: Array<{ type: string }>;
		parsedJsonObject: { language: string };
	};
};

describe("Langflow File Production tool node", () => {
	it("exposes produce_file as the model-facing tool contract", () => {
		const source = nodeSource();

		expect(source).toContain('display_name = "File Production"');
		expect(source).toContain('method="produce_file"');
		expect(source).toContain("def produce_file(self) -> Data:");
		expect(source).toContain("/api/chat/files/produce");
		expect(source).toContain('"alfyai_standard_report"');
		expect(source).toContain('"level":2');

		for (const field of [
			"idempotencyKey",
			"requestTitle",
			"requestedOutputs",
			"sourceMode",
			"documentIntent",
			"templateHint",
			"documentSource",
			"program",
		]) {
			expect(source).toContain(`name="${field}"`);
		}

		expect(source).not.toMatch(/name="conversationId"/);
		expect(source).not.toMatch(/name="outputs"/);
		expect(source).not.toContain('getattr(self, "outputs"');
		expect(source).not.toContain('method="generate_file"');
		expect(source).not.toContain('method="export_document"');
		expect(source).not.toContain("/api/chat/files/generate");
		expect(source).not.toContain("/api/chat/files/export");
		expect(source).toContain('"requestedOutputs": requested_outputs');
		expect(source).toContain('getattr(self, "conversation_id", "")');
		expect(source).toContain('getattr(self, "conversationId", "")');
	});

	it("does not leak internal job identifiers or queue state into model-facing success text", () => {
		const source = nodeSource();

		expect(source).toContain("File production request accepted");
		expect(source).not.toContain("File production job {job.get");
		expect(source).not.toContain("job.get('id', 'unknown')");
		expect(source).not.toContain("job.get('status', 'queued')");
	});

	it("accepts structured document source and program arguments from agent tool calls", () => {
		const contract = runFileProductionNodeContractFixture();

		expect(contract.inputs.documentSource.inputType).toBe("DictInput");
		expect(contract.inputs.documentSource.toolMode).toBe(true);
		expect(contract.inputs.documentSource.info).not.toContain("JSON-encoded");
		expect(contract.inputs.program.inputType).toBe("DictInput");
		expect(contract.inputs.program.toolMode).toBe(true);
		expect(contract.inputs.program.info).not.toContain("JSON-encoded");

		expect(contract.parsedObject).toEqual({ title: "Report" });
		expect(contract.parsedArray).toEqual([{ type: "pdf" }]);
		expect(contract.parsedJsonObject).toEqual({ language: "python" });
	});

	it("keeps Langflow tool inputs aligned with the mixed structured and text schema", () => {
		const source = nodeSource();

		expect(source).toContain(
			"DictInput, DropdownInput, MultilineInput, StrInput",
		);
		expect(source).toMatch(/DictInput\(\s+name="program"/);
		expect(source).toContain(
			"Object with language, sourceCode, and optional filename",
		);
		expect(source).toContain(
			"program must be an object when sourceMode is program.",
		);
		expect(source).toMatch(/DictInput\(\s+name="documentSource"/);
		expect(source).toContain(
			"Object using the AlfyAI Standard Report source shape",
		);
		expect(source).toContain(
			"documentSource must be an object when sourceMode is document_source.",
		);
		expect(source).toContain('name="requestedOutputs"');
		expect(source).toContain(
			"requestedOutputs must be a non-empty JSON-encoded array.",
		);
	});
});
