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
