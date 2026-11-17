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
    assert s.steady_attempts == 4
    assert (s.gap_seconds, s.paragraph_gap_seconds, s.breath_seconds) == (0.45, 0.82, 0.12)


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
            "SPEECH_STEADY_ATTEMPTS": "2",
            "SPEECH_GAP_SECONDS": "0.3",
            "SPEECH_PARAGRAPH_GAP_SECONDS": "0.6",
            "SPEECH_BREATH_SECONDS": "0",
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
        steady_attempts=2,
        gap_seconds=0.3,
        paragraph_gap_seconds=0.6,
        breath_seconds=0.0,
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


@pytest.mark.parametrize("prefetch", ["-1", "-100"])
def test_refuses_a_negative_prefetch(prefetch):
    # Every session would park at the prefetch gate and never read a sentence.
    with pytest.raises(ValueError, match="SPEECH_PREFETCH"):
        Settings.from_env({"SPEECH_PREFETCH": prefetch})
    with pytest.raises(ValueError, match="SPEECH_PREFETCH"):
        Settings(prefetch=int(prefetch))


def test_a_prefetch_of_zero_is_fine():
    # The sentence being read and nothing ahead of it.
    assert Settings.from_env({"SPEECH_PREFETCH": "0"}).prefetch == 0
    assert Settings(prefetch=0).prefetch == 0


@pytest.mark.parametrize(
    "seconds", ["0", "0.0", "-1", "-0.5", "nan", "inf", "Infinity", "-inf"]
)
def test_refuses_an_idle_time_that_is_not_a_finite_number_above_zero(seconds):
    # Every session would end the moment it started (nan: nobody can say when; inf: a session
    # nobody reads never ends, and an ended one is never forgotten).
    with pytest.raises(ValueError, match="SPEECH_IDLE_SECONDS"):
        Settings.from_env({"SPEECH_IDLE_SECONDS": seconds})
    with pytest.raises(ValueError, match="SPEECH_IDLE_SECONDS"):
        Settings(idle_seconds=float(seconds))


def test_a_short_idle_time_is_fine():
    assert Settings.from_env({"SPEECH_IDLE_SECONDS": "0.001"}).idle_seconds == 0.001
    assert Settings(idle_seconds=0.2).idle_seconds == 0.2


@pytest.mark.parametrize("threads", ["0", "-1", "-8"])
def test_refuses_fewer_than_one_aligner_thread(threads):
    with pytest.raises(ValueError, match="SPEECH_ALIGNER_THREADS"):
        Settings.from_env({"SPEECH_ALIGNER_THREADS": threads})
    with pytest.raises(ValueError, match="SPEECH_ALIGNER_THREADS"):
        Settings(aligner_threads=int(threads))


def test_one_aligner_thread_is_fine():
    assert Settings.from_env({"SPEECH_ALIGNER_THREADS": "1"}).aligner_threads == 1
    assert Settings(aligner_threads=1).aligner_threads == 1


@pytest.mark.parametrize(
    ("name", "field"),
    [
        ("SPEECH_GAP_SECONDS", "gap_seconds"),
        ("SPEECH_PARAGRAPH_GAP_SECONDS", "paragraph_gap_seconds"),
        ("SPEECH_BREATH_SECONDS", "breath_seconds"),
    ],
)
@pytest.mark.parametrize("seconds", ["-0.1", "nan", "inf", "-inf", "9"])
def test_refuses_a_gap_or_a_breath_that_is_not_a_short_non_negative_time(name, field, seconds):
    # A negative or endless silence would cut speech or stop a reading; nine seconds is a typo.
    with pytest.raises(ValueError, match=name):
        Settings.from_env({name: seconds})
    with pytest.raises(ValueError, match=name):
        Settings(**{field: float(seconds)})


@pytest.mark.parametrize(
    ("name", "field"),
    [
        ("SPEECH_GAP_SECONDS", "gap_seconds"),
        ("SPEECH_PARAGRAPH_GAP_SECONDS", "paragraph_gap_seconds"),
        ("SPEECH_BREATH_SECONDS", "breath_seconds"),
    ],
)
def test_no_gap_and_no_breath_at_all_is_fine(name, field):
    assert getattr(Settings.from_env({name: "0"}), field) == 0.0
    assert getattr(Settings(**{field: 0.0}), field) == 0.0


@pytest.mark.parametrize("attempts", ["0", "-1", "-4"])
def test_refuses_fewer_than_one_steady_attempt(attempts):
    # A reading needs a clip: with no attempt at all there would never be one.
    with pytest.raises(ValueError, match="SPEECH_STEADY_ATTEMPTS"):
        Settings.from_env({"SPEECH_STEADY_ATTEMPTS": attempts})
    with pytest.raises(ValueError, match="SPEECH_STEADY_ATTEMPTS"):
        Settings(steady_attempts=int(attempts))


def test_one_steady_attempt_is_fine_and_means_no_retry():
    assert Settings.from_env({"SPEECH_STEADY_ATTEMPTS": "1"}).steady_attempts == 1
    assert Settings(steady_attempts=1).steady_attempts == 1


@pytest.mark.parametrize("port", ["0", "-1", "65536", "70000"])
def test_refuses_a_port_outside_1_to_65535(port):
    with pytest.raises(ValueError, match="SPEECH_PORT"):
        Settings.from_env({"SPEECH_PORT": port})
    with pytest.raises(ValueError, match="SPEECH_PORT"):
        Settings(port=int(port))


@pytest.mark.parametrize("port", ["1", "1920", "65535"])
def test_a_port_from_1_to_65535_is_fine(port):
    assert Settings.from_env({"SPEECH_PORT": port}).port == int(port)
    assert Settings(port=int(port)).port == int(port)


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
        "SPEECH_STEADY_ATTEMPTS",
        "SPEECH_GAP_SECONDS",
        "SPEECH_PARAGRAPH_GAP_SECONDS",
        "SPEECH_BREATH_SECONDS",
    ],
)
def test_an_unparsable_number_names_its_variable(name):
    with pytest.raises(ValueError, match=name):
        Settings.from_env({name: "twelve"})


def test_settings_are_frozen():
    s = Settings.from_env({})
    with pytest.raises(FrozenInstanceError):
        s.port = 1  # type: ignore
