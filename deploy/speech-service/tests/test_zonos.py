"""The Zonos client, and the fake of Zonos that the other tests build on."""

import asyncio
import io

import httpx
import numpy as np
import pytest
import soundfile as sf

from speech_service.models import Voice
from speech_service.zonos import SynthesisFailed, ZonosClient, ZonosError, ZonosUnavailable
from tests.fakes_zonos import fake_zonos, refusing_transport
from tests.helpers import SR, VOICE, peak_db, tone

REQUEST_FIELDS = {
    "text",
    "language",
    "format",
    "stream",
    "speaker_embedding_id",
    "speaker_mode",
    "seed",
    "text_normalization",
}


def client_for(handler) -> httpx.AsyncClient:
    """A client whose Zonos is `handler`: a function from request to response (or to an error)."""
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def wav(samples: np.ndarray, sr: int = SR) -> bytes:
    buffer = io.BytesIO()
    sf.write(buffer, samples, sr, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


# What the client sends.


async def test_request_has_exactly_the_contract_fields():
    zonos, calls = fake_zonos()
    await ZonosClient("http://z", zonos).synthesize("Szia.", "hu", Voice("default_x", {"room.clean": 2.0}), 1234)
    assert set(calls[0]) == REQUEST_FIELDS | {"controls"}
    assert calls[0]["speaker_mode"] == "embedding" and calls[0]["text_normalization"] is False


async def test_request_carries_the_text_the_voice_the_controls_and_the_seed():
    zonos, calls = fake_zonos()
    voice = Voice("hu_voice_1", {"room.clean": 2.0, "pace.slow": -0.5})
    await ZonosClient("http://z", zonos).synthesize("Árvíztűrő tükörfúrógép.", "hu", voice, 99)
    assert calls[0] == {
        "text": "Árvíztűrő tükörfúrógép.",
        "language": "hu",
        "format": "wav",
        "stream": False,
        "speaker_embedding_id": "hu_voice_1",
        "speaker_mode": "embedding",
        "seed": 99,
        "text_normalization": False,
        "controls": {"room.clean": 2.0, "pace.slow": -0.5},
    }


async def test_controls_are_left_out_when_there_are_none():
    zonos, calls = fake_zonos()
    await ZonosClient("http://z", zonos).synthesize("Hello.", "en", VOICE, 1234)
    assert set(calls[0]) == REQUEST_FIELDS


@pytest.mark.parametrize(("language", "zonos_language"), [("en", "en_us"), ("hu", "hu")])
async def test_zonos_gets_its_own_language_codes(language, zonos_language):
    zonos, calls = fake_zonos()
    await ZonosClient("http://z", zonos).synthesize("Hello.", language, VOICE, 1)
    assert calls[0]["language"] == zonos_language


async def test_an_unknown_language_is_refused_before_anything_is_sent():
    zonos, calls = fake_zonos()
    with pytest.raises(ValueError, match="language"):
        await ZonosClient("http://z", zonos).synthesize("Bonjour.", "fr", VOICE, 1)
    assert calls == []


async def test_a_slash_at_the_end_of_the_base_url_is_fine():
    paths = []

    def handler(request):
        paths.append(request.url.path)
        return httpx.Response(200, content=wav(tone(0.3, 0.1)))

    await ZonosClient("http://z/", client_for(handler)).synthesize("x", "en", VOICE, 1)
    assert paths == ["/v2/generate"]


async def test_it_connects_within_5_s_and_waits_up_to_120_s_to_read():
    # Zonos queues readings first-in-first-out, so a sentence can wait behind other people's.
    seen = {}

    def handler(request):
        seen.update(request.extensions["timeout"])
        return httpx.Response(200, content=wav(tone(0.3, 0.1)))

    await ZonosClient("http://z", client_for(handler)).synthesize("x", "en", VOICE, 1)
    assert seen["connect"] == 5.0
    assert seen["read"] == 120.0


# What the client returns.


async def test_returns_mono_float32_audio_and_its_sample_rate():
    zonos, _ = fake_zonos()
    audio, sr = await ZonosClient("http://z", zonos).synthesize("Szia.", "hu", VOICE, 1)
    assert sr == 44100
    assert audio.dtype == np.float32
    assert audio.ndim == 1
    assert abs(len(audio) - round((0.06 * len("Szia.") + 0.3) * SR)) <= 1
    assert peak_db(audio) == pytest.approx(-10.46, abs=0.05)  # the fake's tone is at amplitude 0.3


async def test_several_channels_are_averaged_to_mono():
    stereo = np.column_stack([np.full(4410, 0.5), np.full(4410, 0.1)]).astype(np.float32)
    client = client_for(lambda request: httpx.Response(200, content=wav(stereo)))
    audio, _ = await ZonosClient("http://z", client).synthesize("x", "en", VOICE, 1)
    assert audio.shape == (4410,)
    assert audio == pytest.approx(0.3, abs=1e-3)


# What goes wrong.


def test_both_failures_are_zonos_errors_and_neither_is_the_other():
    assert issubclass(ZonosUnavailable, ZonosError)
    assert issubclass(SynthesisFailed, ZonosError)
    assert not issubclass(ZonosUnavailable, SynthesisFailed)
    assert not issubclass(SynthesisFailed, ZonosUnavailable)


async def test_connection_refused_is_unavailable():
    with pytest.raises(ZonosUnavailable):
        await ZonosClient("http://z", refusing_transport()).synthesize("x", "en", VOICE, 1)


@pytest.mark.parametrize(
    "error",
    [
        httpx.ConnectError("Connection refused"),
        httpx.ConnectTimeout("timed out"),
        httpx.ReadTimeout("timed out"),
        httpx.RemoteProtocolError("Server disconnected without sending a response."),
    ],
    ids=lambda error: type(error).__name__,
)
async def test_any_transport_error_is_unavailable(error):
    def handler(request):
        raise error

    with pytest.raises(ZonosUnavailable):
        await ZonosClient("http://z", client_for(handler)).synthesize("x", "en", VOICE, 1)


@pytest.mark.parametrize("status", [400, 422, 500, 503])
async def test_an_error_status_is_a_failed_synthesis_that_names_only_the_status(status):
    text = "Titkos mondat."
    client = client_for(lambda request: httpx.Response(status, json={"detail": f"cannot say: {text}"}))
    with pytest.raises(SynthesisFailed) as failure:
        await ZonosClient("http://z", client).synthesize(text, "hu", VOICE, 1)
    assert str(status) in str(failure.value)
    assert "Titkos" not in repr(failure.value)


async def test_a_refusal_does_not_quote_the_text_either():
    text = "Titkos mondat."
    with pytest.raises(ZonosUnavailable) as failure:
        await ZonosClient("http://z", refusing_transport()).synthesize(text, "hu", VOICE, 1)
    assert "Titkos" not in repr(failure.value)


@pytest.mark.parametrize(
    "body",
    [b"", b"this is not a wav", b"RIFF" + bytes(40), wav(np.zeros(0, dtype=np.float32))],
    ids=["empty", "not-audio", "broken-header", "no-samples"],
)
async def test_audio_that_is_unusable_is_a_failed_synthesis(body):
    client = client_for(lambda request: httpx.Response(200, content=body))
    with pytest.raises(SynthesisFailed):
        await ZonosClient("http://z", client).synthesize("x", "en", VOICE, 1)


# Whether Zonos is up.


async def test_healthy_asks_for_v2_health_and_is_true_on_200():
    zonos, calls = fake_zonos()
    assert await ZonosClient("http://z", zonos).healthy() is True
    assert calls == []  # the fake saw a health check, not a synthesis


async def test_healthy_is_false_on_any_other_answer_and_on_any_error():
    seen = []

    def handler(request):
        seen.append((request.method, request.url.path))
        return httpx.Response(503)

    assert await ZonosClient("http://z", client_for(handler)).healthy() is False
    assert seen == [("GET", "/v2/health")]
    assert await ZonosClient("http://z", refusing_transport()).healthy() is False

    def times_out(request):
        raise httpx.ReadTimeout("timed out")

    assert await ZonosClient("http://z", client_for(times_out)).healthy() is False


# The fake of Zonos.


async def test_the_fake_fails_the_numbered_call_and_records_every_body_in_order():
    zonos, calls = fake_zonos(fail_on=2)
    client = ZonosClient("http://z", zonos)
    await client.synthesize("Egy.", "hu", VOICE, 1)
    with pytest.raises(SynthesisFailed, match="500"):
        await client.synthesize("Kettő.", "hu", VOICE, 1)
    await client.synthesize("Három.", "hu", VOICE, 1)
    assert [call["text"] for call in calls] == ["Egy.", "Kettő.", "Három."]


@pytest.mark.parametrize("concurrency", [1, 2, 3])
async def test_the_fake_serves_at_most_concurrency_calls_at_once(concurrency):
    zonos, calls = fake_zonos(concurrency=concurrency)
    client = ZonosClient("http://z", zonos)
    await asyncio.gather(*(client.synthesize(f"Mondat {i}.", "hu", VOICE, 1) for i in range(6)))
    assert len(calls) == 6
    assert calls.max_in_flight == concurrency


async def test_the_fake_answers_other_paths_with_404():
    zonos, _ = fake_zonos()
    assert (await zonos.get("http://z/v2/nothing")).status_code == 404
