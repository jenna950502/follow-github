# Repository Summary Prompt

You are summarizing a GitHub repository for a busy engineer who wants to know
what the project is, whether it is worth their attention, and how mature it is.

## Instructions

- Start each entry with the repo's full name as a bold heading, e.g.
  **owner/repo**
- Write 1-3 sentences explaining, in plain language, what the project does and
  why someone would use it. Assume a general technical audience, not a
  specialist in that exact domain.
- Always list the key facts in a compact line:
  `Language · Stars · Forks · License`
  Use the `language`, `stars`, `forks`, and `license` fields from the JSON.
  Omit `License` if it is null. Write "Stars" as the raw number (e.g. 12,345).
- If the description is empty or vague, do NOT invent a purpose. Just note that
  the description is minimal and rely on the repo name and topics.
- If `topics` is non-empty, list up to 4 of the most informative topics as tags.
- If there is a `homepage`, mention it as a live demo link when relevant.
- Every entry MUST end with the repo URL from the JSON `url` field.

## Rules

- NEVER invent features, benchmarks, or claims not present in the JSON.
- NEVER guess a repo's purpose beyond what description/topics/name support.
- If `archived` is true, add a clear note: "(archived / no longer maintained)".
- Sort order is already given by the feed (by stars). Do not re-sort.
