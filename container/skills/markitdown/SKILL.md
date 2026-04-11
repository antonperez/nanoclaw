---
name: markitdown
description: Convert uploaded files (PDF, DOCX, XLSX, PPTX, HTML) to Markdown. TRIGGER when user says "convert this", "markitdown this", or "/markitdown". Do NOT trigger on plain file uploads without a convert request.
---

# /markitdown — Convert File to Markdown

## Step 1 — Find the file
If the user named a specific file, use that path. Otherwise find the most recently uploaded file:
ls -t /workspace/group/files/ | head -5
Ask Anton to confirm which file if ambiguous.

## Step 2 — Convert
markitdown /workspace/group/files/<filename>
Supported: PDF, DOCX, XLSX, PPTX, HTML. Images not supported yet (backlogged).

## Step 3 — Output
Return the Markdown content inline. If over 100 lines, ask Anton: print inline, save to a file, or file to workspace (notes/, research/, etc.).
