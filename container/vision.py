#!/usr/bin/env python3
"""
nanoclaw-vision: Describe or transcribe an image using Claude via the credential proxy.

Usage:
  nanoclaw-vision <image_path> [prompt]

Default prompt: "Describe this image. If it contains text, transcribe it as Markdown."
"""

import sys
import os
import json
import base64
import subprocess

MIME_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

DEFAULT_PROMPT = (
    "Describe this image. If it contains text, transcribe it verbatim as Markdown."
)


def build_payload(image_path: str, prompt: str) -> str:
    ext = os.path.splitext(image_path)[1].lower()
    media_type = MIME_TYPES.get(ext)
    if not media_type:
        raise ValueError(f"Unsupported image type '{ext}'. Supported: {', '.join(MIME_TYPES)}")

    with open(image_path, "rb") as f:
        img_data = base64.standard_b64encode(f.read()).decode()

    return json.dumps({
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": img_data,
                    },
                },
                {"type": "text", "text": prompt},
            ],
        },
    })


def parse_response(stdout: str) -> str | None:
    for line in stdout.splitlines():
        try:
            obj = json.loads(line)
            if obj.get("type") == "assistant":
                for block in obj.get("message", {}).get("content", []):
                    if block.get("type") == "text":
                        return block["text"]
        except (json.JSONDecodeError, KeyError):
            continue
    return None


def run_vision(image_path: str, prompt: str) -> str:
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"File not found: {image_path}")

    payload = build_payload(image_path, prompt)

    result = subprocess.run(
        [
            "claude",
            "--model", os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6"),
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "-p",
            "--dangerously-skip-permissions",
            "--verbose",
        ],
        input=payload,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        timeout=120,
    )

    text = parse_response(result.stdout)
    if text is None:
        raise RuntimeError(result.stderr[:300] if result.stderr else "No response from Claude")
    return text


def main():
    if len(sys.argv) < 2:
        print("Usage: nanoclaw-vision <image_path> [prompt]", file=sys.stderr)
        sys.exit(1)

    image_path = sys.argv[1]
    prompt = " ".join(sys.argv[2:]) if len(sys.argv) > 2 else DEFAULT_PROMPT

    try:
        print(run_vision(image_path, prompt))
    except (FileNotFoundError, ValueError, RuntimeError) as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
