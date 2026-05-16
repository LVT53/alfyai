"""
Memory Context Tool for Langflow Agents.

This component exposes AlfyAI's `memory_context` tool. Persona mode asks Honcho
targeted questions about durable user context, history mode searches older
non-project conversations or expands one selected conversation, and project mode
returns bounded Project Folder or lower-authority Project Continuity summaries.
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


class MemoryContextToolComponent(Component):
    """Tool component for conversation-scoped memory context summaries."""

    display_name = "Memory Context"
    description = "Retrieve bounded memory context for the current conversation."
    documentation = "https://docs.langflow.org/tools"
    icon = "brain"
    name = "memory_context"
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
            info="HMAC key for scoped signed assertions on memory context calls",
            value=os.getenv("ALFYAI_API_SIGNING_KEY", ""),
            advanced=True,
        ),
        DropdownInput(
            name="mode",
            display_name="Mode",
            info="Use persona for Honcho user memory, history for older non-project chats, or project for project/folder continuity.",
            options=["persona", "history", "project"],
            value="persona",
            tool_mode=True,
        ),
        StrInput(
            name="query",
            display_name="Query",
            info="Optional memory question or context hint for the lookup.",
            value="",
            tool_mode=True,
        ),
        IntInput(
            name="maxSiblings",
            display_name="Project Result Limit",
            info="Project mode only. Maximum sibling conversation summaries to return. Capped by AlfyAI.",
            value=10,
            tool_mode=True,
        ),
        StrInput(
            name="siblingConversationId",
            display_name="Project Conversation Detail",
            info="Project mode only. Use a conversationId returned by project summary to request detail for one allowed sibling.",
            value="",
            tool_mode=True,
        ),
        IntInput(
            name="maxMessages",
            display_name="Max Messages",
            info="Maximum recent user/assistant messages to return for detail mode. Capped by AlfyAI.",
            value=15,
            tool_mode=True,
        ),
        IntInput(
            name="maxHistoryConversations",
            display_name="Max History Conversations",
            info="Maximum older non-project conversation summaries to return for history mode. Capped by AlfyAI.",
            value=8,
            tool_mode=True,
        ),
        StrInput(
            name="historyConversationId",
            display_name="History Conversation",
            info="Optional. Use a conversationId returned by history mode to request detail for one allowed older conversation.",
            value="",
            tool_mode=True,
        ),
        StrInput(
            name="selectedConversationId",
            display_name="Selected Conversation",
            info="Optional alias for historyConversationId when expanding one returned history conversation.",
            value="",
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
            method="memory_context",
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
            "audience": "memory_context",
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
        mode = str(getattr(self, "mode", "") or "persona").strip() or "persona"
        if mode not in ("project", "persona", "history"):
            return "Unsupported memory_context mode."

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

        sibling_conversation_id = str(
            getattr(self, "siblingConversationId", "") or ""
        ).strip()
        if sibling_conversation_id:
            payload["siblingConversationId"] = sibling_conversation_id

        history_conversation_id = str(
            getattr(self, "historyConversationId", "") or ""
        ).strip()
        if history_conversation_id:
            payload["historyConversationId"] = history_conversation_id

        selected_conversation_id = str(
            getattr(self, "selectedConversationId", "") or ""
        ).strip()
        if selected_conversation_id:
            payload["selectedConversationId"] = selected_conversation_id

        try:
            max_siblings = int(str(getattr(self, "maxSiblings", "") or "").strip())
            if max_siblings > 0:
                payload["maxSiblings"] = max_siblings
        except ValueError:
            pass

        try:
            max_messages = int(str(getattr(self, "maxMessages", "") or "").strip())
            if max_messages > 0:
                payload["maxMessages"] = max_messages
        except ValueError:
            pass

        try:
            max_history_conversations = int(
                str(getattr(self, "maxHistoryConversations", "") or "").strip()
            )
            if max_history_conversations > 0:
                payload["maxHistoryConversations"] = max_history_conversations
        except ValueError:
            pass

        return payload

    def _post_memory_context(
        self,
        payload: dict[str, Any],
        conversation_id: str,
    ) -> dict[str, Any]:
        url = f"{self.alfyai_api_url.rstrip('/')}/api/tools/memory-context"
        headers = {"Content-Type": "application/json"}

        signed_assertion = self._build_service_assertion(conversation_id)
        if signed_assertion:
            headers["Authorization"] = f"Bearer {signed_assertion}"

        try:
            response = requests.post(
                url,
                headers=headers,
                json=payload,
                timeout=45,
                allow_redirects=False,
            )
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
                        f"AlfyAI redirected memory_context to {location or 'another route'} instead of accepting the service call. "
                        "Make sure the deployed app includes /api/tools/memory-context in PUBLIC_PATHS and restart AlfyAI."
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

    def memory_context(self) -> Data:
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
        max_messages = int(payload.get("maxMessages", 6) or 6)
        max_history_conversations = int(
            payload.get("maxHistoryConversations", 8) or 8
        )
        self._emit_tool_marker("TOOL_START", {
            "name": "memory_context",
            "input": {
                "mode": payload.get("mode", "persona"),
                "query": payload.get("query", ""),
                "maxSiblings": max_siblings,
                "siblingConversationId": payload.get("siblingConversationId", ""),
                "maxMessages": max_messages,
                "maxHistoryConversations": max_history_conversations,
                "historyConversationId": payload.get("historyConversationId", ""),
                "selectedConversationId": payload.get("selectedConversationId", ""),
                "includeEvidenceCandidates": payload.get("includeEvidenceCandidates", True),
            },
        })

        logger.info(
            "Fetching memory context in conversation %s via %s",
            conversation_id[:8],
            self.alfyai_api_url.rstrip("/"),
        )
        result = self._post_memory_context(payload, conversation_id)

        if result.get("success"):
            evidence_candidates = result.get("evidenceCandidates", [])
            if not isinstance(evidence_candidates, list):
                evidence_candidates = []
            mode = str(result.get("mode", payload.get("mode", "persona")) or "persona")
            is_detail = bool(
                payload.get("siblingConversationId")
                or payload.get("historyConversationId")
                or payload.get("selectedConversationId")
            )
            if mode == "history" and not is_detail:
                candidate_limit = max_history_conversations
            elif is_detail:
                candidate_limit = max_messages
            else:
                candidate_limit = max_siblings
            bounded_candidates = evidence_candidates[:candidate_limit]
            output_summary = None
            if mode == "persona":
                status = result.get("status", "available")
                output_summary = f"Persona memory status: {status}"
            elif mode == "history":
                status = result.get("status", "available")
                conversations = result.get("conversations", [])
                count = len(conversations) if isinstance(conversations, list) else 0
                output_summary = (
                    f"History memory status: {status}; conversations: {count}"
                )
            elif result.get("hasProjectContext"):
                project = result.get("project", {})
                if isinstance(project, dict):
                    output_summary = f"Project memory found: {project.get('name', 'Project')}"
                else:
                    output_summary = "Project memory found."
            else:
                output_summary = "No project memory found for this conversation."

            audit = result.get("audit", {})
            metadata = {
                "mode": mode,
                "status": result.get("status"),
                "hasProjectContext": bool(result.get("hasProjectContext", False)),
                "omittedSiblingCount": result.get("omittedSiblingCount", 0),
                "omittedConversationCount": result.get("omittedConversationCount", 0),
            }
            if isinstance(audit, dict):
                for key in (
                    "requestedMaxSiblings",
                    "appliedMaxSiblings",
                    "requestedMaxHistoryConversations",
                    "appliedMaxHistoryConversations",
                    "requestedMaxMessages",
                    "appliedMaxMessages",
                ):
                    value = audit.get(key)
                    if isinstance(value, (str, int, float, bool)) or value is None:
                        metadata[key] = value
            selected_conversation = result.get("selectedConversation")
            if isinstance(selected_conversation, dict):
                omitted_message_count = selected_conversation.get(
                    "omittedMessageCount",
                    0,
                )
                if isinstance(omitted_message_count, (int, float)):
                    metadata["omittedMessageCount"] = omitted_message_count

            self._emit_tool_marker("TOOL_END", {
                "name": "memory_context",
                "sourceType": "memory",
                "outputSummary": output_summary,
                "candidates": evidence_candidates[:candidate_limit],
                "metadata": metadata,
            })
            return Data(data={
                "success": True,
                "name": "memory_context",
                "sourceType": "memory",
                "mode": mode,
                "status": result.get("status"),
                "hasProjectContext": result.get("hasProjectContext", False),
                "source": result.get("source", "none"),
                "content": result.get("content"),
                "project": result.get("project"),
                "siblings": result.get("siblings", []),
                "selectedSibling": result.get("selectedSibling"),
                "omittedSiblingCount": result.get("omittedSiblingCount", 0),
                "conversations": result.get("conversations", []),
                "selectedConversation": result.get("selectedConversation"),
                "omittedConversationCount": result.get("omittedConversationCount", 0),
                "evidenceCandidates": bounded_candidates,
                "audit": result.get("audit", {}),
                "instructions": (
                    "Use this as memory context only. Persona mode contains durable user context from Honcho. "
                    "History mode contains older non-project chat summaries or one selected conversation detail. "
                    "Project mode contains bounded project and deep-research summaries, not raw transcripts. "
                    "Do not claim details that are not present in the returned payload."
                ),
            })

        error_message = str(result.get("error", "Unknown memory context error"))
        logger.error(f"Memory context failed: {error_message}")
        self._emit_tool_marker("TOOL_END", {
            "name": "memory_context",
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
