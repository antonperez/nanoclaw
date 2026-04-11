"""Tests for vision.py — unit tests only, no subprocess or API calls."""

import json
import os
import tempfile
import pytest

from vision import build_payload, parse_response, MIME_TYPES


# ---------------------------------------------------------------------------
# build_payload
# ---------------------------------------------------------------------------

def _make_image(suffix=".jpg") -> str:
    """Create a minimal valid JPEG-ish temp file."""
    f = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    f.write(b"\xff\xd8\xff\xe0test")  # fake JPEG header
    f.close()
    return f.name


def test_build_payload_jpeg():
    path = _make_image(".jpg")
    try:
        payload = build_payload(path, "describe this")
        obj = json.loads(payload)
        msg = obj["message"]
        assert msg["role"] == "user"
        content = msg["content"]
        assert content[0]["type"] == "image"
        assert content[0]["source"]["media_type"] == "image/jpeg"
        assert content[1]["type"] == "text"
        assert content[1]["text"] == "describe this"
    finally:
        os.unlink(path)


def test_build_payload_png():
    path = _make_image(".png")
    try:
        payload = build_payload(path, "what is this?")
        obj = json.loads(payload)
        assert obj["message"]["content"][0]["source"]["media_type"] == "image/png"
    finally:
        os.unlink(path)


def test_build_payload_encodes_base64():
    path = _make_image(".jpg")
    try:
        payload = build_payload(path, "test")
        obj = json.loads(payload)
        data = obj["message"]["content"][0]["source"]["data"]
        import base64
        decoded = base64.standard_b64decode(data)
        assert decoded == open(path, "rb").read()
    finally:
        os.unlink(path)


def test_build_payload_unsupported_extension():
    path = _make_image(".bmp")
    try:
        with pytest.raises(ValueError, match="Unsupported image type"):
            build_payload(path, "test")
    finally:
        os.unlink(path)


def test_build_payload_jpeg_alias():
    path = _make_image(".jpeg")
    try:
        payload = build_payload(path, "test")
        obj = json.loads(payload)
        assert obj["message"]["content"][0]["source"]["media_type"] == "image/jpeg"
    finally:
        os.unlink(path)


def test_all_supported_extensions():
    for ext in MIME_TYPES:
        path = _make_image(ext)
        try:
            payload = build_payload(path, "test")
            obj = json.loads(payload)
            assert obj["message"]["content"][0]["source"]["media_type"] == MIME_TYPES[ext]
        finally:
            os.unlink(path)


# ---------------------------------------------------------------------------
# parse_response
# ---------------------------------------------------------------------------

def _stream_line(**kwargs) -> str:
    return json.dumps(kwargs)


def test_parse_response_extracts_text():
    stdout = "\n".join([
        _stream_line(type="system", message="init"),
        _stream_line(type="assistant", message={"content": [{"type": "text", "text": "Hello world"}]}),
        _stream_line(type="result", message="done"),
    ])
    assert parse_response(stdout) == "Hello world"


def test_parse_response_returns_first_text_block():
    stdout = "\n".join([
        _stream_line(type="assistant", message={"content": [
            {"type": "text", "text": "first"},
            {"type": "text", "text": "second"},
        ]}),
    ])
    assert parse_response(stdout) == "first"


def test_parse_response_skips_non_text_blocks():
    stdout = "\n".join([
        _stream_line(type="assistant", message={"content": [
            {"type": "tool_use", "name": "Bash"},
            {"type": "text", "text": "result text"},
        ]}),
    ])
    assert parse_response(stdout) == "result text"


def test_parse_response_no_assistant_returns_none():
    stdout = "\n".join([
        _stream_line(type="system", message="init"),
        _stream_line(type="result", message="done"),
    ])
    assert parse_response(stdout) is None


def test_parse_response_empty_stdout():
    assert parse_response("") is None


def test_parse_response_ignores_bad_json():
    stdout = "not json\n" + _stream_line(type="assistant", message={"content": [{"type": "text", "text": "ok"}]})
    assert parse_response(stdout) == "ok"
