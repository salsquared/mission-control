# LLM prompt blobs

Source-of-truth-during-migration artifacts for LOP-6 (per-callsite prompt-registry migration). One `.md` file per callsite slug — same names as the inventory in [`../implementation.md`](../implementation.md) §LLM observability and the `name:` field in every `chatJSON` call.

## Roles

- **Now (pre-LOP-6):** prompts live inline in the codebase (`SYSTEM_PROMPT` constants + builders). These files are a snapshot for migration prep — paste into Lunary's template UI to seed the registry.
- **After LOP-6 (per-callsite cutover):** Lunary becomes the runtime live copy; these files stay as the canonical disk snapshot. Treat them as the source of truth — every prompt edit lands here first (so `git log -p docs/llm-prompts/<slug>.md` diffs cleanly), then gets pasted to Lunary.
- **Disaster recovery:** if Lunary is down or you migrate to self-host, these are what gets re-imported.

## File shape

```markdown
# <slug>

**Callsite:** `<path/to/file.ts>` (or "fill mode" / "rewrite mode" when one file has both)
**Model:** <MODEL_FLASH | MODEL_LITE | MODEL_LITE_CHEAP> (`<gemini-id>`)
**Temperature:** <value>
**Max output tokens:** <value>
**Bypasses chatJSON?** <no | yes (Vercel AI SDK)>

## System

[verbatim system prompt — paste exactly into Lunary's "system" field]

## User template

[user prompt with `{{var}}` markers replacing the dynamic sections built in code]

## Variables

- `var_name` — what it carries; where it comes from in the codebase; any byte/length caps applied client-side before substitution.

## Notes

[anything non-obvious — overflow trim order, mode branching, schema-validation quirks, etc.]
```

## Naming convention

Slug = the `name:` field passed to `chatJSON` (or to `lunary.trackEvent` for email-parser). Kebab-case. **One slug per Lunary template** — bullet-assist has two slugs (`bullet-assist-fill` + `bullet-assist-rewrite`) because the prompts and output schemas differ meaningfully.

## When to update these files

- Editing the live prompt in code → update the file in the same commit.
- Editing the Lunary template via dashboard → mirror the change back here, same-day.
- Adding a new callsite → add its file here as part of the `chatJSON({ name: ... })` PR. Also add a row to `../llm-calls.html` and an entry to `../implementation.md` §LLM observability.
