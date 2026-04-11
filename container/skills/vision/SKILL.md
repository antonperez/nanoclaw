---
name: vision
description: Describe, transcribe, translate, or analyze an image sent by the user. TRIGGER when the user sends an image file and asks to describe, read, transcribe, translate, summarize, or analyze it. Do NOT trigger on plain image uploads without a request.
---

# /vision — Analyze an Image

## Step 1 — Find the image
If the user named a specific file, use that path. Otherwise find the most recently uploaded image:
```
ls -t /workspace/group/files/ | head -5
```
Supported formats: JPG, JPEG, PNG, GIF, WEBP. Ask Anton to confirm if ambiguous.

## Step 2 — Analyze
Run the vision tool with the user's request as the prompt:
```
nanoclaw-vision /workspace/group/files/<filename> "<user's request>"
```

Examples:
- "what does this say?" → `nanoclaw-vision photo.jpg "Transcribe all text verbatim as Markdown"`
- "describe this" → `nanoclaw-vision photo.jpg "Describe this image in detail"`
- "translate this" → `nanoclaw-vision photo.jpg "Translate all text in this image to English"`
- "summarize this chart" → `nanoclaw-vision photo.jpg "Summarize the data shown in this chart"`

## Step 3 — Output
Return the result inline. If over 100 lines, ask Anton: print inline, save to a file, or file to workspace.
