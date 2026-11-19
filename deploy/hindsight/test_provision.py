import importlib.util
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("provision", pathlib.Path(__file__).with_name("provision.py"))
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)

class ProvisionTests(unittest.TestCase):
    def test_paired_secret_files_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory)
            provision.write_bindings(["a3f54a51-679f-4211-9920-519ec8cb821d", "a3f54a51-679f-4211-9920-519ec8cb821e"], target)
            app = (target / "alfyai-tenants.env").read_text()
            native = (target / "native-tenants.env").read_text()
            self.assertIn("HINDSIGHT_TENANT_KEYS=", app)
            self.assertIn("HINDSIGHT_API_TENANT_USERS=", native)
            self.assertEqual((target / "alfyai-tenants.env").stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                provision.write_bindings(["a3f54a51-679f-4211-9920-519ec8cb821d"], target)
            self.assertEqual((target / "alfyai-tenants.env").read_text(), app)

    def test_rejects_nonopaque_and_duplicate_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            for values in (["user@example.com"], ["a3f54a51-679f-4211-9920-519ec8cb821d"] * 2):
                with self.assertRaises(ValueError):
                    provision.write_bindings(values, pathlib.Path(directory))


class MasterKeyProvisioning(unittest.TestCase):
    def test_default_bundle_is_private_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            directory = pathlib.Path(root)
            provision.write_master_bindings(directory)
            app = (directory / "alfyai-tenants.env").read_text()
            native = (directory / "native-tenants.env").read_text()
            self.assertIn("HINDSIGHT_TENANT_MASTER_KEYS", app)
            self.assertIn("HINDSIGHT_API_TENANT_MASTER_KEYS", native)
            settings = (directory / "native-db.env").read_text()
            worker_id = next((line for line in settings.splitlines() if line.startswith("HINDSIGHT_API_WORKER_ID=")), "")
            self.assertRegex(worker_id, r"^HINDSIGHT_API_WORKER_ID=alfyai-memory-[a-f0-9]{32}$")
            self.assertEqual((directory / "alfyai-tenants.env").stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                provision.write_master_bindings(directory)
            self.assertTrue((directory / "native-db.env").read_text() == settings)

    def test_explicit_worker_identity_is_saved_only_in_native_settings(self):
        with tempfile.TemporaryDirectory() as root:
            directory = pathlib.Path(root)
            provision.write_master_bindings(directory, worker_id="alfyai-memory-stage")
            self.assertIn("HINDSIGHT_API_WORKER_ID=alfyai-memory-stage\n", (directory / "native-db.env").read_text())
            self.assertNotIn("WORKER_ID", (directory / "alfyai-tenants.env").read_text())

    def test_malformed_worker_identity_is_rejected_before_writing(self):
        with tempfile.TemporaryDirectory() as root:
            directory = pathlib.Path(root)
            with self.assertRaises(ValueError):
                provision.write_master_bindings(directory, worker_id="invalid\nentry")
            self.assertEqual(list(directory.iterdir()), [])

    def test_database_password_round_trips_through_the_compose_connection(self):
        import json
        import os
        import shutil
        import subprocess
        from unittest.mock import patch
        from urllib.parse import unquote, urlsplit

        if not shutil.which("docker"):
            self.skipTest("Docker Compose CLI unavailable")
        with tempfile.TemporaryDirectory() as root:
            directory = pathlib.Path(root)
            with patch.object(provision.secrets, "token_urlsafe", return_value="synth@/:%pass"):
                provision.write_master_bindings(directory, worker_id="alfyai-memory-stage")
            shutil.copy(pathlib.Path(__file__).with_name("compose.yaml"), directory)
            (directory / "native-model.env").touch()
            command = ["docker", "compose", "--env-file", "native-db.env", "config", "--format", "json"]
            env = {
                key: value for key, value in os.environ.items()
                if not key.startswith("HINDSIGHT_DB_PASSWORD") and key != "HINDSIGHT_API_WORKER_ID"
            }
            result = subprocess.run(
                command,
                cwd=directory, env=env,
                check=True, capture_output=True, text=True,
            )
            services = json.loads(result.stdout)["services"]
            password = services["postgres"]["environment"]["POSTGRES_PASSWORD"]
            database_url = services["hindsight"]["environment"]["HINDSIGHT_API_DATABASE_URL"]
            self.assertEqual(unquote(urlsplit(database_url).password), password)
            self.assertEqual(password, "synth@/:%pass")
            self.assertEqual(services["hindsight"]["environment"]["HINDSIGHT_API_WORKER_ID"], "alfyai-memory-stage")
            self.assertEqual((directory / "native-db.env").stat().st_mode & 0o777, 0o600)
            env_file = directory / "native-db.env"
            env_file.write_text("\n".join(
                line for line in env_file.read_text().splitlines()
                if not line.startswith("HINDSIGHT_API_WORKER_ID=")
            ) + "\n")
            result = subprocess.run(command, cwd=directory, env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Set a persistent native worker ID", result.stderr)
