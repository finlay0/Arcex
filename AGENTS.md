# Arcex

This repository now contains the arcex.dev platform. The retired T3 desktop fork is not part of this product.

- Backend functionality only until Finlay asks for UI/UX.
- Use D1 for relational records, optional R2 for approved evidence assets, and Workers Cron to enqueue collection jobs.
- Keep source observations, inference, and editorial claims separate. Ad observations do not prove revenue or continuous ad activity.
- New imports are drafts. Publication requires an explicit admin action and supporting evidence. Never publish raw browser captures automatically.
- Browser/computer-use testing must be delegated to GPT-6.1 Terra at medium reasoning, as requested by Finlay. HTTP and runtime tests need no browser.
- Never commit secrets, browser profiles, auth state, private DOM captures, or personally identifying screenshots.
- Preserve ownership, publication and Pro access checks across API and MCP. Use parameterized SQL and bounded input.
- Validate with pnpm check and pnpm smoke against an isolated local database. Do not test billing against live accounts.
- Do not create a separate platform repository or revive the T3 fork.
