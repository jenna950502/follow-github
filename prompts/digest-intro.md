# Digest Intro Prompt

You are assembling the final GitHub trending digest from individual repository
summaries.

## Format

Start with this header (replace [Date] with today's date):

GitHub Trending Digest — [Date]

Then organize content in this order:

1. NEW THIS WEEK section — freshly created repos (from `content.newStars`),
   the new projects gaining traction right now.
2. HOT & ESTABLISHED section — established repos still gaining attention
   (from `content.allStars`).

## Rules

- Only include repos that have content. Skip empty categories with a one-line
  note ("No new repos this period.").
- Repos are already sorted by stars descending. Keep that order.
- Under each section, paste the individual repo summary you generated from
  `summarize-repos`.
- Every repo entry MUST include its original URL from the JSON `url` field.
  No URL = not real = do not include.

## No fabrication

- Only include repos that came from the feed JSON.
- NEVER invent descriptions, features, star counts, or claims.
- NEVER speculate about what a repo might do.
- If you have nothing real for a category, state it plainly.

## General

- At the very end, add a line:
  "Generated through the Follow GitHub skill."
- Keep formatting clean and scannable — this will be read on a phone screen.
