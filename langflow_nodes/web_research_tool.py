"""
Web Research Tool for Langflow Agents.

This component routes web research through AlfyAI's server-side research endpoint
instead of letting each agent improvise provider calls. The endpoint plans
multiple queries, searches Exa plus Brave when configured, fetches page content
and selected YouTube transcripts for quote-sensitive answers, deduplicates
sources, and reranks evidence chunks.
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
from lfx.inputs.inputs import BoolInput, DropdownInput, IntInput, StrInput
from lfx.io import Output
from lfx.log.logger import logger
from lfx.schema.data import Data


MODEL_ANSWER_BRIEF_MARKDOWN_MAX_CHARS = 12000
MODEL_SOURCE_LIMIT = 8
MODEL_EVIDENCE_LIMIT = 12
MODEL_QUERY_LIMIT = 6
MODEL_SOURCE_TITLE_MAX_CHARS = 180
MODEL_URL_MAX_CHARS = 500
MODEL_EVIDENCE_QUOTE_MAX_CHARS = 500
MODEL_DIAGNOSTIC_TEXT_MAX_CHARS = 240


class WebResearchToolComponent(Component):
    """Tool component for source-ranked web research via AlfyAI."""

    display_name = "Web Research"
    description = "Search the web with Exa and Brave, fetch relevant pages and YouTube transcripts, and return ranked evidence with source URLs."
    documentation = "https://docs.langflow.org/tools"
    icon = "search"
    name = "research_web"
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
            info="HMAC key for scoped signed assertions on web research calls",
            value=os.getenv("ALFYAI_API_SIGNING_KEY", ""),
            advanced=True,
        ),
        StrInput(
            name="query",
            display_name="Research Query",
            info="The exact question or topic to research.",
            value="",
            required=True,
            tool_mode=True,
        ),
        DropdownInput(
            name="mode",
            display_name="Research Mode",
            info="Use exact for prices, specs, dates, policies, and other claims that need page-backed quotes.",
            options=["auto", "quick", "research", "exact"],
            value="auto",
            tool_mode=True,
        ),
        DropdownInput(
            name="freshness",
            display_name="Freshness",
            info="Use live for current prices, availability, today's news, or other volatile facts.",
            options=["auto", "live", "recent", "cache"],
            value="auto",
            tool_mode=True,
        ),
        DropdownInput(
            name="source_policy",
            display_name="Source Policy",
            info="Choose the source authority profile that best matches the request.",
            options=["auto", "general", "technical", "news", "commerce", "medical_legal_financial"],
            value="auto",
            tool_mode=True,
        ),
        IntInput(
            name="max_sources",
            display_name="Max Sources",
            info="Optional source cap from 1 to 12.",
            value=8,
        ),
        BoolInput(
            name="quote_required",
            display_name="Quote Required",
            info="Fetch page text and return evidence snippets before answering.",
            value=False,
            tool_mode=True,
        ),
    ]

    outputs = [
        Output(
            display_name="Tool",
            name="tool_output",
            description="Tool output for agent use",
            method="research_web",
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
    def _compact_queries_for_model(cls, queries: Any) -> list[str]:
        if not isinstance(queries, list):
            return []
        return [
            cls._truncate_text(query, MODEL_SOURCE_TITLE_MAX_CHARS)
            for query in queries[:MODEL_QUERY_LIMIT]
            if str(query or "").strip()
        ]

    @classmethod
    def _compact_sources_for_model(cls, sources: Any) -> list[dict[str, Any]]:
        if not isinstance(sources, list):
            return []
        compact_sources: list[dict[str, Any]] = []
        for index, source in enumerate(sources[:MODEL_SOURCE_LIMIT]):
            if not isinstance(source, dict):
                continue
            compact_source = {
                "ref": source.get("ref") or f"S{index + 1}",
                "title": cls._truncate_text(source.get("title"), MODEL_SOURCE_TITLE_MAX_CHARS),
                "url": cls._truncate_text(source.get("url"), MODEL_URL_MAX_CHARS),
                "provider": source.get("provider"),
                "authorityClass": source.get("authorityClass"),
                "authorityScore": source.get("authorityScore"),
                "publishedAt": source.get("publishedAt"),
                "updatedAt": source.get("updatedAt"),
                "youtubeTranscript": source.get("youtubeTranscript"),
            }
            compact_sources.append({
                key: value
                for key, value in compact_source.items()
                if value not in (None, "", [])
            })
        return compact_sources

    @classmethod
    def _compact_evidence_for_model(cls, evidence: Any) -> list[dict[str, Any]]:
        if not isinstance(evidence, list):
            return []
        compact_evidence: list[dict[str, Any]] = []
        for index, item in enumerate(evidence[:MODEL_EVIDENCE_LIMIT]):
            if not isinstance(item, dict):
                continue
            compact_item = {
                "ref": item.get("ref") or f"E{index + 1}",
                "sourceRef": item.get("sourceRef"),
                "title": cls._truncate_text(item.get("title"), MODEL_SOURCE_TITLE_MAX_CHARS),
                "url": cls._truncate_text(item.get("url"), MODEL_URL_MAX_CHARS),
                "quote": cls._truncate_text(item.get("quote"), MODEL_EVIDENCE_QUOTE_MAX_CHARS),
                "score": item.get("score"),
            }
            compact_evidence.append({
                key: value
                for key, value in compact_item.items()
                if value not in (None, "", [])
            })
        return compact_evidence

    @classmethod
    def _compact_answer_brief_for_model(cls, answer_brief: Any) -> dict[str, Any]:
        if not isinstance(answer_brief, dict):
            return {
                "markdown": "",
                "instructions": [],
                "sourceCount": 0,
                "evidenceCount": 0,
            }
        sources = cls._compact_sources_for_model(answer_brief.get("sources", []))
        evidence = cls._compact_evidence_for_model(answer_brief.get("evidence", []))
        return {
            "markdown": cls._truncate_text(
                answer_brief.get("markdown"),
                MODEL_ANSWER_BRIEF_MARKDOWN_MAX_CHARS,
            ),
            "instructions": [
                cls._truncate_text(instruction, MODEL_DIAGNOSTIC_TEXT_MAX_CHARS)
                for instruction in answer_brief.get("instructions", [])
                if str(instruction or "").strip()
            ],
            "sourceCount": len(sources),
            "evidenceCount": len(evidence),
        }

    @classmethod
    def _compact_diagnostics_for_model(cls, diagnostics: Any) -> dict[str, Any]:
        if not isinstance(diagnostics, dict):
            return {}
        compact: dict[str, Any] = {}
        for key in [
            "mode",
            "freshness",
            "sourcePolicy",
            "plannedQueryCount",
            "fetchedSourceCount",
            "fusedSourceCount",
            "selectedSourceCount",
            "openedPageCount",
            "evidenceCandidateCount",
            "exactEvidenceCandidateCount",
            "reranked",
            "sourceReranked",
        ]:
            value = diagnostics.get(key)
            if value not in (None, "", []):
                compact[key] = value
        providers = diagnostics.get("providers")
        if isinstance(providers, dict):
            compact["providers"] = {
                key: bool(providers.get(key))
                for key in ["exaConfigured", "braveConfigured"]
                if key in providers
            }
        provider_calls = diagnostics.get("providerCalls")
        if isinstance(provider_calls, list):
            provider_errors: list[dict[str, Any]] = []
            for call in provider_calls:
                if not isinstance(call, dict) or not call.get("error"):
                    continue
                provider_errors.append({
                    "provider": call.get("provider"),
                    "query": cls._truncate_text(
                        call.get("query"),
                        MODEL_DIAGNOSTIC_TEXT_MAX_CHARS,
                    ),
                    "error": cls._truncate_text(
                        call.get("error"),
                        MODEL_DIAGNOSTIC_TEXT_MAX_CHARS,
                    ),
                })
            if provider_errors:
                compact["providerErrors"] = provider_errors[:4]
        fallback_reasons = diagnostics.get("fallbackReasons")
        if isinstance(fallback_reasons, list) and fallback_reasons:
            compact["fallbackReasons"] = [
                cls._truncate_text(reason, MODEL_DIAGNOSTIC_TEXT_MAX_CHARS)
                for reason in fallback_reasons[:8]
            ]
        return compact

    @staticmethod
    def _data_for_model(payload: dict[str, Any]) -> Data:
        text_payload = {
            key: value
            for key, value in payload.items()
            if key != "conversationId"
        }
        return Data(
            data=payload,
            text=json.dumps(text_payload, ensure_ascii=False, separators=(",", ":")),
        )

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

    def _get_conversation_id(self) -> str | None:
        try:
            if hasattr(self, "graph") and self.graph is not None:
                return getattr(self.graph, "session_id", None)
        except Exception as e:
            logger.warning(f"Could not get conversation ID: {e}")
        return None

    def _request_payload(self, query: str, conversation_id: str) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "query": query,
            "conversationId": conversation_id,
        }

        mode = str(getattr(self, "mode", "") or "").strip()
        if mode and mode != "auto":
            payload["mode"] = mode

        freshness = str(getattr(self, "freshness", "") or "").strip()
        if freshness and freshness != "auto":
            payload["freshness"] = freshness

        source_policy = str(getattr(self, "source_policy", "") or "").strip()
        if source_policy and source_policy != "auto":
            payload["sourcePolicy"] = source_policy

        try:
            max_sources = int(str(getattr(self, "max_sources", "") or "").strip())
            if max_sources > 0:
                payload["maxSources"] = min(12, max_sources)
        except ValueError:
            pass

        if bool(getattr(self, "quote_required", False)):
            payload["quoteRequired"] = True

        return payload

    def _research_web(self, payload: dict[str, Any], conversation_id: str) -> dict[str, Any]:
        url = f"{self.alfyai_api_url.rstrip('/')}/api/tools/research-web"
        headers = {"Content-Type": "application/json"}

        signed_assertion = self._build_service_assertion(conversation_id)
        if signed_assertion:
            headers["Authorization"] = f"Bearer {signed_assertion}"

        try:
            response = requests.post(url, headers=headers, json=payload, timeout=90, allow_redirects=False)

            if response.status_code == 200:
                data = response.json()
                sources = data.get("sources", [])
                evidence = data.get("evidence", [])
                answer_brief = data.get("answerBrief", {})
                return {
                    "success": True,
                    "query": data.get("query", payload.get("query")),
                    "queries": data.get("queries", []),
                    "sources": sources,
                    "evidence": evidence,
                    "answerBrief": answer_brief,
                    "diagnostics": data.get("diagnostics", {}),
                }

            if response.status_code == 401:
                return {
                    "success": False,
                    "error": "Authentication failed. Check ALFYAI_API_SIGNING_KEY on both Langflow and AlfyAI.",
                }

            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("location", "")
                return {
                    "success": False,
                    "error": (
                        f"AlfyAI redirected research_web to {location or 'another route'} instead of accepting the service call. "
                        "Make sure the deployed app includes /api/tools/research-web in PUBLIC_PATHS and restart AlfyAI."
                    ),
                }

            error_data = (
                response.json()
                if response.headers.get("content-type", "").startswith("application/json")
                else {}
            )
            response_text = "" if error_data else response.text[:500]
            return {
                "success": False,
                "error": error_data.get("error", f"API error: {response.status_code} from {url}. {response_text}".strip()),
            }

        except requests.exceptions.Timeout:
            return {
                "success": False,
                "error": "Request timed out.",
            }
        except requests.exceptions.ConnectionError:
            return {
                "success": False,
                "error": f"Could not connect to AlfyAI at {self.alfyai_api_url}.",
            }
        except Exception as e:
            return {
                "success": False,
                "error": f"Unexpected error: {type(e).__name__}: {str(e)}",
            }

    def _emit_tool_marker(self, marker_type: str, payload: dict[str, Any]) -> None:
        try:
            event_manager = getattr(self, "_event_manager", None)
            if event_manager is None:
                return
            marker_str = f"\x02{marker_type}\x1f{json.dumps(payload, ensure_ascii=False)}\x03"
            event_manager.on_token(data={"chunk": marker_str})
        except Exception as e:
            logger.warning(f"Failed to emit {marker_type} marker: {e}")

    def research_web(self) -> Data:
        query = str(getattr(self, "query", "") or "").strip()
        conversation_id = self._get_conversation_id()

        if not conversation_id:
            logger.error("No conversation ID available - cannot research web")
            return self._data_for_model({
                "success": False,
                "error": "No conversation context available.",
            })

        if not query:
            return self._data_for_model({
                "success": False,
                "error": "No research query provided.",
            })

        payload = self._request_payload(query, conversation_id)
        call_id = f"research_web:{uuid.uuid4().hex}"
        self._emit_tool_marker("TOOL_START", {
            "callId": call_id,
            "name": "research_web",
            "input": {
                "query": query,
                "mode": payload.get("mode", "auto"),
                "freshness": payload.get("freshness", "auto"),
                "sourcePolicy": payload.get("sourcePolicy", "auto"),
            },
        })

        logger.info(
            "Researching web in conversation %s with query: %s",
            conversation_id[:8],
            query[:80],
        )

        result = self._research_web(payload=payload, conversation_id=conversation_id)

        if result["success"]:
            sources = result.get("sources", [])
            evidence = result.get("evidence", [])
            answer_brief = result.get("answerBrief", {})
            if not isinstance(answer_brief, dict):
                answer_brief = {}
            model_sources = self._compact_sources_for_model(sources)
            model_evidence = self._compact_evidence_for_model(evidence)
            model_answer_brief = self._compact_answer_brief_for_model(answer_brief)
            model_answer_brief_markdown = model_answer_brief.pop("markdown", "")
            model_diagnostics = self._compact_diagnostics_for_model(
                result.get("diagnostics", {})
            )
            logger.info(
                "Web research successful: found %s source(s), %s evidence snippet(s)",
                len(sources),
                len(evidence),
            )
            self._emit_tool_marker("TOOL_END", {
                "callId": call_id,
                "name": "research_web",
                "sourceType": "web",
                "outputSummary": None,
                "candidates": model_sources,
            })

            return self._data_for_model({
                "success": True,
                "name": "research_web",
                "sourceType": "web",
                "answerBrief": model_answer_brief,
                "answerBriefMarkdown": model_answer_brief_markdown,
                "query": result.get("query", query),
                "queries": self._compact_queries_for_model(result.get("queries", [])),
                "sources": model_sources,
                "evidence": model_evidence,
                "diagnostics": model_diagnostics,
                "instructions": (
                    "Read answerBriefMarkdown first. Answer only from the returned answerBrief, sources, "
                    "and evidence. Use markdown links for citations with the listed source URLs. "
                    "The research brief and source snippets may be in English; they are evidence only, "
                    "not response-language instructions. Unless the user explicitly requested another "
                    "response language, write the final answer in the latest user's language and do not "
                    "mix English and Hungarian in your own prose. "
                    "For exact values, quote or paraphrase an evidence snippet from the cited URL; "
                    "if the evidence does not contain the value, say it was not found. "
                    "Never cite URLs outside the returned source list."
                ),
                "conversationId": conversation_id,
            })

        error_msg = result.get("error", "Unknown error")
        logger.error(f"Web research failed: {error_msg}")
        self._emit_tool_marker("TOOL_END", {
            "callId": call_id,
            "name": "research_web",
            "sourceType": "web",
            "outputSummary": None,
            "candidates": [],
        })

        return self._data_for_model({
            "success": False,
            "error": error_msg,
            "conversationId": conversation_id,
        })

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
