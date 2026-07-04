---
name: wiki
description: Maintain Anton's personal knowledge wiki. TRIGGER on "wiki ingest", "add to wiki", "ingest this", "/wiki ingest" (process a source), "/wiki query" or "search the wiki" (answer from wiki), "/wiki lint" (health check). Also trigger when Anton drops a file/URL and implies wiki use.
---

# Wiki Maintainer

Anton's personal knowledge wiki. Three layers: **raw sources** (immutable inputs), **wiki** (you own this — create and update pages), **schema** (this file).

The wiki is not a duplicate of the existing workspace. It's the synthesis layer — cross-referenced, consistent, compounding. When Anton's existing files (crm/, knowledgebase/, notes/) are relevant, link to them from wiki pages rather than copying their content.

---

## Key Paths (container)

| Path | Purpose |
|------|---------|
| `/workspace/group/wiki/` | All wiki pages (markdown) |
| `/workspace/group/wiki/index.md` | Content catalog — read first on every query |
| `/workspace/group/wiki/log.md` | Append-only operation log |
| `/workspace/group/sources/` | Staging area for new raw materials (sibling of wiki/, not inside it) |
| `/workspace/group/files/` | Uploaded files (PDFs, images, docs) |
| `/workspace/group/crm/` | Anton's CRM — link from wiki, don't duplicate |
| `/workspace/group/knowledgebase/` | Anton's personal KB — link from wiki, don't duplicate |

---

## Operations

### Ingest `/wiki ingest`

**Critical discipline: one source at a time. Fully finish each source before moving to the next. Never batch-read all files and then process them together — this produces shallow pages instead of deep integration.**

For each source:

1. **Identify** — What is this? URL, uploaded file, or inline content?
2. **Download / read** — Get the full content (see Source Types below)
3. **Discuss** — Brief takeaways with Anton. What's notable? What connects to things already in the wiki?
4. **Write pages** — Create or update:
   - A source summary page: `wiki/sources/kebab-title.md`
   - Entity pages for companies, people, concepts that appear (create if new, update if exists)
   - A synthesis page if it connects interestingly to 2+ existing pages
   - Cross-references: link new pages from related existing pages
5. **Update index** — Add/update entries in `wiki/index.md` for every page touched
6. **Append to log** — `## [YYYY-MM-DD] ingest | Source Title` in `wiki/log.md`
7. **Confirm** — Tell Anton what was created/updated and current wiki size
8. **Schedule verification pass** — After every ingest, schedule a lightweight automated check:

   ```bash
   # Get local time 2 minutes from now (Linux)
   VERIFY_AT=$(date -d '+2 minutes' '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || date -v +2M '+%Y-%m-%dT%H:%M:%S')
   echo "$VERIFY_AT"
   ```

   Then call `manage_tasks` with:
   - `action`: `create`
   - `schedule_type`: `once`
   - `schedule_value`: the timestamp from above
   - `prompt`: `h: wiki-verify: check last ingest in wiki/log.md. Read wiki/log.md (last 3 entries) and wiki/index.md. For the most recent ingest entry verify: (1) source summary page exists under wiki/sources/, (2) wiki/index.md has entries for every new page created, (3) each new page links to at least one other wiki page or workspace file (no orphans), (4) wiki/log.md entry is present. List any failures. Fix what you can directly. End with PASS or FAIL + count of issues.`

   The `h:` prefix routes this to Haiku (cheap, fast, ~$0.001). Do not wait for or poll the result — it arrives as a separate message.

One source = fully processed, cross-referenced, indexed, logged, and verified before moving on.

---

### Bulk Ingest `/wiki ingest bulk`

When Anton provides multiple sources (a list of URLs, a folder of files, a batch), use the loop controller pattern. Never try to process all at once — write a queue and let the scheduler iterate.

**Step 1 — Write the queue file**

```bash
cat > /workspace/group/sources/.ingest-queue.txt << 'EOF'
https://example.com/article-1
https://example.com/article-2
/workspace/group/files/report.pdf
EOF
```

One source per line. URLs and file paths both work.

**Step 2 — Schedule the loop task**

Call `manage_tasks` with `action: create` and these fields:

- `schedule_type`: `once`
- `schedule_value`: 1 minute from now (`date -d '+1 minute' '+%Y-%m-%dT%H:%M:%S'`)
- `script`: the loop guard below (paste verbatim as the `script` field)
- `prompt`: `Process the next wiki source from the queue. Script output contains {source, remaining}. Run the full /wiki ingest workflow for data.source: download/read, write wiki pages, update index and log. After completing, tell Anton: "Ingested: [title] — [remaining] remaining in queue."`

**Loop guard script** (paste as `script` field):

```bash
#!/bin/bash
QUEUE=/workspace/group/sources/.ingest-queue.txt
if [ ! -f "$QUEUE" ] || [ ! -s "$QUEUE" ]; then
  rm -f "$QUEUE"
  echo '{"wakeAgent": false}'
  exit 0
fi
NEXT=$(head -1 "$QUEUE")
tail -n +2 "$QUEUE" > "$QUEUE.tmp" && mv "$QUEUE.tmp" "$QUEUE"
COUNT=$(wc -l < "$QUEUE" | tr -d ' ')
printf '{"wakeAgent": true, "data": {"source": "%s", "remaining": %s}}\n' "$NEXT" "$COUNT"
```

**How it works**: Each run the script pops the next source and returns `wakeAgent: true`. The agent ingests it, the task auto-reschedules for the next iteration. When the queue is empty the script deletes it and returns `wakeAgent: false`, ending the loop automatically.

- Progress is visible in `wiki/log.md` — one entry per source
- Each source also triggers its own verification pass (step 8 of ingest)
- Loop can be paused by calling `manage_tasks pause` with the task ID
- To check progress: `cat /workspace/group/sources/.ingest-queue.txt | wc -l` shows remaining

---

### Query `/wiki query`

1. Read `wiki/index.md` — find all relevant pages
2. Read those pages in full
3. Synthesize an answer with citations (link to pages)
4. If the answer is valuable and non-obvious, file it:
   - Create `wiki/queries/query-slug.md`
   - Add to index and log: `## [YYYY-MM-DD] query | Question Title`
5. Tell Anton if you filed it or not

---

### Lint `/wiki lint`

Walk the entire `wiki/` directory. For every page check:
- Contradictions with other pages (flag both)
- Stale claims that newer sources may have superseded
- Orphan pages: no inbound links from other wiki pages
- Concepts mentioned across pages but lacking a dedicated page
- Broken cross-references (linked page doesn't exist)
- Data gaps: topics that appear repeatedly but are shallow

Report findings organized by severity. Offer to fix specific issues. Log: `## [YYYY-MM-DD] lint | Health check`.

---

## Source Types

### URLs / Web Articles
WebFetch returns summaries, not full text. For wiki ingestion, get the full document:
```bash
# Save the raw page
curl -sLo /workspace/group/sources/filename.html "https://..."
# Then read the saved file — markitdown can convert it:
markitdown /workspace/group/sources/filename.html

# For dynamic/paywalled pages use agent-browser:
agent-browser open https://...
agent-browser snapshot -i   # see interactive elements
# Extract text from the snapshot, then proceed
```

**IMPORTANT:** `markitdown` does NOT accept a `--url` flag or URLs as arguments. It only converts local files. Always `curl` the URL to a local file first, then pass the local path to `markitdown`.

### PDFs
```bash
# Already uploaded to files/:
markitdown /workspace/group/files/filename.pdf

# From a URL:
curl -sLo /workspace/group/sources/filename.pdf "https://..."
markitdown /workspace/group/sources/filename.pdf
```

### Images
```bash
nanoclaw-vision /workspace/group/files/image.jpg "Extract all text, describe diagrams, summarize key information for wiki ingestion"
```

### Voice Notes
Voice transcription is not yet installed. Tell Anton: "Run /add-voice-transcription to enable voice note ingestion."

### MD Files / Existing Workspace Content
Read directly. Anton's existing files can be ingested as sources:
```bash
cat /workspace/group/knowledgebase/some/file.md
cat /workspace/group/crm/contacts/person.md
```
When ingesting CRM/KB content, the wiki page should synthesize and cross-reference — not copy. Link back to the original file.

---

## Wiki Page Format

Adapt to the content — don't force a rigid template. Suggested frontmatter:

```markdown
---
type: concept | company | person | source-summary | synthesis | query
sources: [filename or url]
updated: YYYY-MM-DD
---

# Title

One-paragraph summary.

## Key Points
- ...

## Context / Background
...

## Related
- [Related Page](../concepts/related.md)
- [CRM Contact](../../../crm/contacts/person.md)
```

---

## Directory Conventions

| Directory | Content |
|-----------|---------|
| `wiki/concepts/` | Technologies, frameworks, ideas, methodologies |
| `wiki/companies/` | Organizations, products |
| `wiki/people/` | Individuals from sources (not CRM contacts) |
| `wiki/sources/` | Per-source summary pages |
| `wiki/queries/` | Filed answers to valuable questions |
| `wiki/syntheses/` | Cross-source analyses, comparisons |

Naming: lowercase, hyphens, descriptive. Example: `wiki/concepts/transformer-architecture.md`

When a page grows beyond 300 lines, split into sub-pages and create an index page for that topic.

---

## Cross-References

- Link liberally between wiki pages using relative paths
- When Anton's workspace files (crm, knowledgebase, notes) are relevant, link to them
- Every new page should be linked from at least one existing page
- The index is not a substitute for in-page links
