"""
File Production Tool for Langflow Agents.

This component exposes AlfyAI's unified `produce_file` tool. It creates durable
job-backed generated-file cards for downloadable artifacts, including source-first
documents and program-generated files.

Usage in Langflow:
1. Add this component to your flow
2. Connect the "Tool" output to an Agent component's "Tools" input
3. The agent can call `produce_file` when the user requests a downloadable file

Environment Variables:
- ALFYAI_API_URL: Base URL of the AlfyAI application (default: http://localhost:3000)
- ALFYAI_API_SIGNING_KEY: HMAC key for signed service assertions on `/api/chat/files/produce`
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import uuid
from typing import Any

import requests

from lfx.custom.custom_component.component import Component
from lfx.inputs.inputs import DictInput, DropdownInput, MultilineInput, StrInput
from lfx.io import Output
from lfx.log.logger import logger
from lfx.schema.data import Data


MODEL_FILE_PRODUCTION_ERROR_MAX_CHARS = 500
MODEL_FILE_PRODUCTION_FILE_LIMIT = 5


class FileProductionToolComponent(Component):
    """Unified tool component for creating durable AlfyAI generated-file jobs."""

    display_name = "File Production"
    description = "Create durable downloadable files using AlfyAI's unified file-production system."
    documentation = "https://docs.langflow.org/tools"
    icon = "file-plus"
    name = "FileProductionTool"
    beta = False

    inputs = [
        StrInput(
            name="alfyai_api_url",
            display_name="AlfyAI API URL",
            info="Base URL of the AlfyAI application (e.g., http://localhost:3000)",
            value=os.getenv("ALFYAI_API_URL", "http://localhost:3000"),
            advanced=True,
        ),
        StrInput(
            name="alfyai_api_signing_key",
            display_name="AlfyAI API Signing Key",
            info="HMAC key for scoped signed assertions on file-production calls",
            value=os.getenv("ALFYAI_API_SIGNING_KEY", ""),
            advanced=True,
        ),
        StrInput(
            name="idempotencyKey",
            display_name="Idempotency Key",
            info="Stable key for this requested file, such as turn-id:request-slug",
            value="",
            required=True,
            tool_mode=True,
        ),
        StrInput(
            name="requestTitle",
            display_name="Request Title",
            info="Short user-facing title for the generated-file card",
            value="Generated file",
            required=True,
            tool_mode=True,
        ),
        MultilineInput(
            name="requestedOutputs",
            display_name="Outputs",
            info='JSON-encoded array of requested outputs, for example [{"type":"pdf"}] or [{"type":"csv"}]',
            value='[{"type":"pdf"}]',
            required=True,
            tool_mode=True,
        ),
        DropdownInput(
            name="sourceMode",
            display_name="Source Mode",
            info='Use "document_source" for reports/documents and "program" for code-generated artifacts.',
            options=["document_source", "program"],
            value="document_source",
            required=True,
            tool_mode=True,
        ),
        StrInput(
            name="documentIntent",
            display_name="Document Intent",
            info="Short model hint such as report, analysis_brief, spreadsheet, slides, or data_export",
            value="report",
            required=True,
            tool_mode=True,
        ),
        StrInput(
            name="templateHint",
            display_name="Template Hint",
            info="Optional style/template hint such as standard-report, compact, or visual-report",
            value="",
            advanced=True,
            tool_mode=True,
        ),
        DictInput(
            name="documentSource",
            display_name="Document Source",
            info=(
                'Object using the AlfyAI Standard Report source shape. Required when sourceMode is document_source. '
                'Include version: 1, template: "alfyai_standard_report", title, and blocks. '
                'Heading blocks use {"type":"heading","level":2,"text":"Section title"}.'
            ),
            value={},
            required=False,
            tool_mode=True,
        ),
        DictInput(
            name="program",
            display_name="Program",
            info='Object with language, sourceCode, and optional filename. Required when sourceMode is program.',
            value={},
            required=False,
            tool_mode=True,
        ),
    ]

    outputs = [
        Output(
            display_name="Tool",
            name="tool_output",
            description="Tool output for agent use",
            method="produce_file",
        ),
    ]

    @staticmethod
    def _base64url_encode(payload: bytes) -> str:
        return base64.urlsafe_b64encode(payload).decode("utf-8").rstrip("=")

    @staticmethod
    def _truncate_text(value: Any, max_chars: int) -> str:
        text = str(value or "")
        if len(text) <= max_chars:
            return text
        return text[:max_chars].rstrip() + "..."

    @classmethod
    def _compact_files_for_model(cls, files: Any) -> list[dict[str, Any]]:
        if not isinstance(files, list):
            return []
        compact_files: list[dict[str, Any]] = []
        for file in files[:MODEL_FILE_PRODUCTION_FILE_LIMIT]:
            if not isinstance(file, dict):
                continue
            compact_file = {
                "id": file.get("id"),
                "filename": file.get("filename") or file.get("name"),
                "mimeType": file.get("mimeType"),
                "sizeBytes": file.get("sizeBytes"),
            }
            compact_files.append({
                key: value
                for key, value in compact_file.items()
                if value not in (None, "", [])
            })
        return compact_files

    @classmethod
    def _compact_job_for_model(cls, job: Any) -> dict[str, Any] | None:
        if not isinstance(job, dict):
            return None
        compact_job = {
            "id": job.get("id"),
            "status": job.get("status"),
            "stage": job.get("stage"),
            "requestTitle": job.get("requestTitle"),
            "sourceMode": job.get("sourceMode"),
            "documentIntent": job.get("documentIntent"),
            "files": cls._compact_files_for_model(job.get("files", [])),
            "error": cls._truncate_text(
                job.get("error") or job.get("errorMessage"),
                MODEL_FILE_PRODUCTION_ERROR_MAX_CHARS,
            ),
        }
        return {
            key: value
            for key, value in compact_job.items()
            if value not in (None, "", [])
        }

    @staticmethod
    def _parse_json_field(value: Any, fallback: Any = None) -> Any:
        if value is None:
            return fallback
        if isinstance(value, (dict, list)):
            return value
        text = str(value).strip()
        if not text:
            return fallback
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return fallback

    def _get_conversation_id(self) -> str | None:
        """Get the conversation ID from the Langflow session."""
        try:
            explicit_snake = str(getattr(self, "conversation_id", "") or "").strip()
            if explicit_snake:
                return explicit_snake

            explicit_camel = str(getattr(self, "conversationId", "") or "").strip()
            if explicit_camel:
                return explicit_camel

            if hasattr(self, "graph") and self.graph is not None:
                return getattr(self.graph, "session_id", None)
        except Exception as exc:
            logger.warning(f"Could not get conversation ID: {exc}")
        return None

    def _build_service_assertion(self, conversation_id: str) -> str | None:
        signing_key = str(getattr(self, "alfyai_api_signing_key", "") or "").strip()
        if not signing_key:
            return None

        payload = {
            "conversationId": conversation_id,
            "userId": str(getattr(self, "user_id", "") or "").strip() or "service",
            "exp": int(time.time() * 1000) + 5 * 60 * 1000,
        }
        payload_json = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        payload_part = self._base64url_encode(payload_json)
        signature = hmac.new(
            signing_key.encode("utf-8"),
            payload_part.encode("utf-8"),
            hashlib.sha256,
        ).digest()
        signature_part = self._base64url_encode(signature)
        return f"{payload_part}.{signature_part}"

    def _emit_tool_marker(self, marker_type: str, payload: dict[str, Any]) -> None:
        try:
            event_manager = getattr(self, "_event_manager", None)
            if event_manager is None:
                return
            marker = f"\x02{marker_type}\x1f{json.dumps(payload, ensure_ascii=False)}\x03"
            event_manager.on_token(data={"chunk": marker})
        except Exception as exc:
            logger.warning(f"Failed to emit {marker_type} marker: {exc}")

    def _build_payload(self, conversation_id: str) -> dict[str, Any] | str:
        idempotency_key = str(getattr(self, "idempotencyKey", "") or "").strip()
        request_title = str(getattr(self, "requestTitle", "") or "").strip()
        source_mode = str(getattr(self, "sourceMode", "") or "").strip()
        document_intent = str(getattr(self, "documentIntent", "") or "").strip()
        template_hint = str(getattr(self, "templateHint", "") or "").strip()
        requested_outputs = self._parse_json_field(
            getattr(self, "requestedOutputs", None),
            fallback=None,
        )
        document_source = self._parse_json_field(
            getattr(self, "documentSource", None),
            fallback=None,
        )
        program = self._parse_json_field(getattr(self, "program", None), fallback=None)

        if not idempotency_key:
            return "idempotencyKey is required."
        if not request_title:
            return "requestTitle is required."
        if not isinstance(requested_outputs, list) or not requested_outputs:
            return "requestedOutputs must be a non-empty JSON-encoded array."
        if source_mode not in {"document_source", "program"}:
            return 'sourceMode must be "document_source" or "program".'
        if not document_intent:
            return "documentIntent is required."
        if source_mode == "document_source" and (
            not isinstance(document_source, dict) or not document_source
        ):
            return "documentSource must be an object when sourceMode is document_source."
        if source_mode == "program" and (not isinstance(program, dict) or not program):
            return "program must be an object when sourceMode is program."

        payload: dict[str, Any] = {
            "conversationId": conversation_id,
            "idempotencyKey": idempotency_key,
            "requestTitle": request_title,
            "requestedOutputs": requested_outputs,
            # Backward-compatible until all server instances read requestedOutputs.
            "outputs": requested_outputs,
            "sourceMode": source_mode,
            "documentIntent": document_intent,
        }
        if template_hint:
            payload["templateHint"] = template_hint
        if source_mode == "document_source":
            payload["documentSource"] = document_source
        else:
            payload["program"] = program
        return payload

    def _post_produce(self, payload: dict[str, Any], conversation_id: str) -> dict[str, Any]:
        url = f"{self.alfyai_api_url.rstrip('/')}/api/chat/files/produce"
        headers = {"Content-Type": "application/json"}

        signed_assertion = self._build_service_assertion(conversation_id)
        if signed_assertion:
            headers["Authorization"] = f"Bearer {signed_assertion}"

        try:
            response = requests.post(url, headers=headers, json=payload, timeout=120)
            data = (
                response.json()
                if response.headers.get("content-type", "").startswith("application/json")
                else {}
            )
            if response.status_code == 202:
                return {"success": True, **data}
            if response.status_code == 401:
                return {
                    "success": False,
                    "error": "Authentication failed. Check ALFYAI_API_SIGNING_KEY on both Langflow and AlfyAI.",
                    **data,
                }
            if response.status_code == 404:
                return {
                    "success": False,
                    "error": "Conversation not found. The session may have expired.",
                    **data,
                }
            return {
                "success": False,
                "error": data.get("error", f"API error: {response.status_code}"),
                **data,
            }
        except requests.exceptions.Timeout:
            return {
                "success": False,
                "error": "Request timed out while creating the file-production job.",
            }
        except requests.exceptions.ConnectionError:
            return {
                "success": False,
                "error": f"Could not connect to AlfyAI at {self.alfyai_api_url}. Check if the server is running.",
            }
        except Exception as exc:
            return {
                "success": False,
                "error": f"Unexpected error: {type(exc).__name__}: {str(exc)}",
            }

    def produce_file(self) -> Data:
        """Tool function called by the agent via Langflow tool mode."""
        conversation_id = self._get_conversation_id()
        if not conversation_id:
            logger.error("No conversation ID available - cannot produce files")
            return Data(
                data={
                    "success": False,
                    "error": "No conversation context available. Cannot create files outside of a chat session.",
                }
            )

        payload_or_error = self._build_payload(conversation_id)
        if isinstance(payload_or_error, str):
            return Data(data={"success": False, "error": payload_or_error})
        payload = payload_or_error
        call_id = f"produce_file:{uuid.uuid4().hex}"

        self._emit_tool_marker(
            "TOOL_START",
            {
                "callId": call_id,
                "name": "produce_file",
                "input": {
                    "requestTitle": payload.get("requestTitle"),
                    "sourceMode": payload.get("sourceMode"),
                    "requestedOutputs": payload.get("requestedOutputs"),
                },
            },
        )

        logger.info(
            "Creating file-production job in conversation %s via %s",
            conversation_id[:8],
            self.alfyai_api_url.rstrip("/"),
        )
        result = self._post_produce(payload, conversation_id)

        if result.get("success"):
            job = result.get("job", {})
            model_job = self._compact_job_for_model(job)
            model_files = (
                model_job.get("files", [])
                if isinstance(model_job, dict)
                else []
            )
            summary = "File production request accepted. The chat card will update when the file is ready."
            self._emit_tool_marker(
                "TOOL_END",
                {
                    "callId": call_id,
                    "name": "produce_file",
                    "sourceType": "tool",
                    "outputSummary": summary,
                    "candidates": model_files,
                },
            )
            return Data(
                data={
                    "success": True,
                    "message": summary,
                    "job": model_job,
                    "reused": bool(result.get("reused")),
                    "conversationId": conversation_id,
                }
            )

        error_message = self._truncate_text(
            result.get("error", "Unknown file-production error"),
            MODEL_FILE_PRODUCTION_ERROR_MAX_CHARS,
        )
        model_job = self._compact_job_for_model(result.get("job"))
        logger.error(f"File production failed: {error_message}")
        self._emit_tool_marker(
            "TOOL_END",
            {
                "callId": call_id,
                "name": "produce_file",
                "sourceType": "tool",
                "outputSummary": None,
                "candidates": [],
            },
        )
        return Data(
            data={
                "success": False,
                "error": error_message,
                "job": model_job,
                "conversationId": conversation_id,
            }
        )

    def update_build_config(
        self,
        build_config: dict,
        field_value: Any,
        field_name: str | None = None,
    ) -> dict:
        if "alfyai_api_url" in build_config:
            current_value = build_config["alfyai_api_url"].get("value", "")
            if not current_value:
                build_config["alfyai_api_url"]["value"] = os.getenv(
                    "ALFYAI_API_URL",
                    "http://localhost:3000",
                )
        return build_config
