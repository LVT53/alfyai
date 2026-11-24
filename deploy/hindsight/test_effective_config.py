"""Verify the shipped service manifest against the pinned engine's parser."""
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import yaml
from hindsight_api.config import HindsightConfig


class EffectiveConfigTests(unittest.TestCase):
    def test_native_model_content_trace_is_disabled(self):
        source = Path(__file__).with_name("compose.yaml").read_text()
        compose_environment = yaml.safe_load(source)["services"]["hindsight"]["environment"]
        with patch.dict(os.environ, compose_environment):
            config = HindsightConfig.from_env()
        self.assertIs(config.llm_trace_enabled, False)
        self.assertIs(config.llm_trace_delete_with_document, True)

    def test_every_native_model_call_outlasts_its_wait_in_the_admission_queue(self):
        """Hindsight's own model calls wait in the gateway's queue before they run.

        A call the engine gives up on while it waits is retried, so its timeout must
        outlast the native wait plus the model's own run (the gateway's 180 s upstream
        timeout). Each LLM timeout the engine parses from the shipped manifest counts.
        """
        from alfyai_admission_queue import admission_settings

        source = Path(__file__).with_name("compose.yaml").read_text()
        compose_environment = yaml.safe_load(source)["services"]["hindsight"]["environment"]
        with patch.dict(os.environ, compose_environment):
            config = HindsightConfig.from_env()
        fields = config.model_dump() if hasattr(config, "model_dump") else vars(config)
        timeouts = {
            name: value
            for name, value in fields.items()
            if "llm" in name and "timeout" in name and isinstance(value, (int, float))
        }
        self.assertTrue(timeouts, "the engine parses no LLM timeout: check the setting's name at the pin")
        # The extension reads HINDSIGHT_API_HTTP_<KEY> as <key>, as Hindsight hands it over.
        prefix = "HINDSIGHT_API_HTTP_"
        extension_config = {
            name[len(prefix):].lower(): value
            for name, value in compose_environment.items()
            if name.startswith(prefix)
        }
        native_wait_s = admission_settings(extension_config).native_wait_s
        for name, value in timeouts.items():
            self.assertGreaterEqual(value, native_wait_s + 180, name)

