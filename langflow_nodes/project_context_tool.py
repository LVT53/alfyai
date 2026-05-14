"""
Project Context Tool for Langflow Agents.

This component exposes AlfyAI's `project_context` summary tool. It returns
bounded Project Folder or lower-authority Project Continuity summaries for the
current conversation without exposing raw transcripts.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

import requests

from lfx.custom.custom_component.component import Component
from lfx.inputs.inputs import BoolInput, DropdownInput, IntInput, StrInput
from lfx.io import Output
from lfx.log.logger import logger
from lfx.schema.data import Data


class ProjectContextToolComponent(Component):
    """Tool component for conversation-scoped project context summaries."""

    display_name = "Project Context"
    description = "Retrieve bounded project folder or continuity summaries for the current conversation."
    documentation = "https://docs.langflow.org/tools"
    icon = "folder-search"
    name = "project_context"
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
            info="HMAC key for scoped signed assertions on project context calls",
            value=os.getenv("ALFYAI_API_SIGNING_KEY", ""),
            advanced=True,
        ),
        DropdownInput(
            name="mode",
            display_name="Mode",
            info="Only summary mode is currently supported.",
            options=["summary"],
            value="summary",
            tool_mode=True,
        ),
        StrInput(
            name="query",
            display_name="Query",
            info="Optional hint for why project context is being requested.",
            value="",
            tool_mode=True,
        ),
        IntInput(
            name="maxSiblings",
            display_name="Max Siblings",
            info="Maximum sibling conversation summaries to return. Capped by AlfyAI.",
            value=5,
            tool_mode=True,
        ),
        BoolInput(
            name="includeEvidenceCandidates",
            display_name="Evidence Candidates",
            info="Include bounded memory evidence candidates for the returned summaries.",
            value=True,
            tool_mode=True,
        ),
    ]

    outputs = [
        Output(
            display_name="Tool",
            name="tool_output",
            description="Tool output for agent use",
            method="project_context",
        ),
    ]

    @staticmethod
    def _base64url_encode(payload: bytes) -> str:
        return base64.urlsafe_b64encode(payload).decode("utf-8").rstrip("=")

    def _get_conversation_id(self) -> str | None:
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
        mode = str(getattr(self, "mode", "") or "summary").strip() or "summary"
        if mode != "summary":
            return "Only summary mode is supported for project_context."

        payload: dict[str, Any] = {
            "conversationId": conversation_id,
            "mode": mode,
            "includeEvidenceCandidates": bool(
                getattr(self, "includeEvidenceCandidates", True)
            ),
        }

        query = str(getattr(self, "query", "") or "").strip()
        if query:
            payload["query"] = query

        try:
            max_siblings = int(str(getattr(self, "maxSiblings", "") or "").strip())
            if max_siblings > 0:
                payload["maxSiblings"] = max_siblings
        except ValueError:
            pass

        return payload

    def _post_project_context(self, payload: dict[str, Any], conversation_id: str) -> dict[str, Any]:
        url = f"{self.alfyai_api_url.rstrip('/')}/api/tools/project-context"
        headers = {"Content-Type": "application/json"}

        signed_assertion = self._build_service_assertion(conversation_id)
        if signed_assertion:
            headers["Authorization"] = f"Bearer {signed_assertion}"

        try:
            response = requests.post(url, headers=headers, json=payload, timeout=45, allow_redirects=False)
            data = (
                response.json()
                if response.headers.get("content-type", "").startswith("application/json")
                else {}
            )

            if response.status_code == 200:
                return {"success": True, **data}
            if response.status_code == 401:
                return {
                    "success": False,
                    "error": "Authentication failed. Check ALFYAI_API_SIGNING_KEY on both Langflow and AlfyAI.",
                    **data,
                }
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("location", "")
                return {
                    "success": False,
                    "error": (
                        f"AlfyAI redirected project_context to {location or 'another route'} instead of accepting the service call. "
                        "Make sure the deployed app includes /api/tools/project-context in PUBLIC_PATHS and restart AlfyAI."
                    ),
                }
            return {
                "success": False,
                "error": data.get("error", f"API error: {response.status_code}"),
                **data,
            }
        except requests.exceptions.Timeout:
            return {"success": False, "error": "Request timed out."}
        except requests.exceptions.ConnectionError:
            return {
                "success": False,
                "error": f"Could not connect to AlfyAI at {self.alfyai_api_url}.",
            }
        except Exception as exc:
            return {
                "success": False,
                "error": f"Unexpected error: {type(exc).__name__}: {str(exc)}",
            }

    def project_context(self) -> Data:
        conversation_id = self._get_conversation_id()
        if not conversation_id:
            return Data(data={
                "success": False,
                "error": "No conversation context available.",
            })

        payload_or_error = self._build_payload(conversation_id)
        if isinstance(payload_or_error, str):
            return Data(data={"success": False, "error": payload_or_error})
        payload = payload_or_error

        max_siblings = int(payload.get("maxSiblings", 5) or 5)
        self._emit_tool_marker("TOOL_START", {
            "name": "project_context",
            "input": {
                "mode": payload.get("mode", "summary"),
                "query": payload.get("query", ""),
                "maxSiblings": max_siblings,
                "includeEvidenceCandidates": payload.get("includeEvidenceCandidates", True),
            },
        })

        logger.info(
            "Fetching project context in conversation %s via %s",
            conversation_id[:8],
            self.alfyai_api_url.rstrip("/"),
        )
        result = self._post_project_context(payload, conversation_id)

        if result.get("success"):
            evidence_candidates = result.get("evidenceCandidates", [])
            if not isinstance(evidence_candidates, list):
                evidence_candidates = []
            bounded_candidates = evidence_candidates[:max_siblings]
            output_summary = None
            if result.get("hasProjectContext"):
                project = result.get("project", {})
                if isinstance(project, dict):
                    output_summary = f"Project context found: {project.get('name', 'Project')}"
                else:
                    output_summary = "Project context found."
            else:
                output_summary = "No project context found for this conversation."

            self._emit_tool_marker("TOOL_END", {
                "name": "project_context",
                "sourceType": "memory",
                "outputSummary": output_summary,
                "candidates": evidence_candidates[:max_siblings],
            })
            return Data(data={
                "success": True,
                "name": "project_context",
                "sourceType": "memory",
                "mode": result.get("mode", "summary"),
                "hasProjectContext": result.get("hasProjectContext", False),
                "source": result.get("source", "none"),
                "project": result.get("project"),
                "siblings": result.get("siblings", []),
                "omittedSiblingCount": result.get("omittedSiblingCount", 0),
                "evidenceCandidates": bounded_candidates,
                "audit": result.get("audit", {}),
                "instructions": (
                    "Use this as memory context only. It contains bounded project summaries, not raw transcripts. "
                    "Do not claim details that are not present in the returned summaries."
                ),
            })

        error_message = str(result.get("error", "Unknown project context error"))
        logger.error(f"Project context failed: {error_message}")
        self._emit_tool_marker("TOOL_END", {
            "name": "project_context",
            "sourceType": "memory",
            "outputSummary": None,
            "candidates": [],
        })
        return Data(data={"success": False, "error": error_message})

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
