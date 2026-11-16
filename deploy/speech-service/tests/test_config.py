"""Settings: the loopback-only rule, the defaults and the SPEECH_* variables."""

from dataclasses import FrozenInstanceError

import pytest

from speech_service.config import Settings


def test_defaults_are_loopback_and_spec_values():
    s = Settings.from_env({})
    assert (s.host, s.port, s.prefetch, s.seed) == ("127.0.0.1", 1920, 2, 1234)


def test_refuses_a_non_loopback_host():
    with pytest.raises(ValueError):
        Settings.from_env({"SPEECH_HOST": "0.0.0.0"})


def test_reads_overrides():
    s = Settings.from_env({"SPEECH_ZONOS_URL": "http://127.0.0.1:1921", "SPEECH_ALIGNER": "none"})
    assert s.zonos_url.endswith(":1921") and s.aligner == "none"


def test_the_other_defaults():
    s = Settings.from_env({})
    assert s.zonos_url == "http://127.0.0.1:1919"
    assert (s.aligner, s.aligner_model, s.aligner_cli, s.aligner_threads) == (
        "python",
        None,
        "fusealign-cli",
        4,
    )
    assert (s.idle_seconds, s.max_sentence_chars) == (30.0, 400)


def test_reads_every_variable():
    s = Settings.from_env(
        {
            "SPEECH_ZONOS_URL": "http://127.0.0.1:1921",
            "SPEECH_HOST": "::1",
            "SPEECH_PORT": "1930",
            "SPEECH_PREFETCH": "3",
            "SPEECH_SEED": "99",
            "SPEECH_ALIGNER": "native",
            "SPEECH_ALIGNER_MODEL": "/models/fusealign",
            "SPEECH_ALIGNER_CLI": "/usr/local/bin/fusealign-cli",
            "SPEECH_ALIGNER_THREADS": "8",
            "SPEECH_IDLE_SECONDS": "12.5",
        }
    )
    assert s == Settings(
        zonos_url="http://127.0.0.1:1921",
        host="::1",
        port=1930,
        prefetch=3,
        seed=99,
        aligner="native",
        aligner_model="/models/fusealign",
        aligner_cli="/usr/local/bin/fusealign-cli",
        aligner_threads=8,
        idle_seconds=12.5,
    )


@pytest.mark.parametrize(
    "name",
    [
        "SPEECH_ZONOS_URL",
        "SPEECH_HOST",
        "SPEECH_ALIGNER",
        "SPEECH_ALIGNER_MODEL",
        "SPEECH_ALIGNER_CLI",
    ],
)
def test_a_blank_string_setting_counts_as_unset(name):
    assert Settings.from_env({name: ""}) == Settings()


@pytest.mark.parametrize("host", ["127.0.0.1", "127.0.0.2", "127.255.255.254", "::1", "localhost"])
def test_accepts_loopback_hosts(host):
    assert Settings.from_env({"SPEECH_HOST": host}).host == host


@pytest.mark.parametrize(
    "host",
    [
        "0.0.0.0",
        "::",
        "192.168.1.20",
        "100.64.0.7",
        "8.8.8.8",
        "126.255.255.255",
        "128.0.0.1",
        "example.com",
        "localhost.example.com",
    ],
)
def test_refuses_every_other_host(host):
    with pytest.raises(ValueError, match="SPEECH_HOST"):
        Settings.from_env({"SPEECH_HOST": host})


def test_a_settings_built_by_hand_is_checked_too():
    with pytest.raises(ValueError):
        Settings(host="0.0.0.0")
    with pytest.raises(ValueError):
        Settings(host="")  # uvicorn would bind every interface
    with pytest.raises(ValueError):
        Settings(aligner="gpu")  # type: ignore


@pytest.mark.parametrize("aligner", ["python", "native", "none"])
def test_accepts_each_aligner(aligner):
    assert Settings.from_env({"SPEECH_ALIGNER": aligner}).aligner == aligner


def test_refuses_an_unknown_aligner():
    with pytest.raises(ValueError, match="SPEECH_ALIGNER"):
        Settings.from_env({"SPEECH_ALIGNER": "gpu"})


@pytest.mark.parametrize(
    "name",
    [
        "SPEECH_PORT",
        "SPEECH_PREFETCH",
        "SPEECH_SEED",
        "SPEECH_ALIGNER_THREADS",
        "SPEECH_IDLE_SECONDS",
    ],
)
def test_an_unparsable_number_names_its_variable(name):
    with pytest.raises(ValueError, match=name):
        Settings.from_env({name: "twelve"})


def test_settings_are_frozen():
    s = Settings.from_env({})
    with pytest.raises(FrozenInstanceError):
        s.port = 1  # type: ignore
