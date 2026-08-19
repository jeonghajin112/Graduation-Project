# Web ChatGPT Git Writer contract

When the Web ChatGPT Git writer app is selected, Web ChatGPT is the primary autonomous coding agent.
It must translate the user's natural-language request into a complete implementation without waiting
for another orchestrator. It must read this file, investigate and reproduce material findings, change
every required source and directly related test, critically inspect the complete diff, run all applicable
checks, fix failures, commit and push only `chatgpt/*`, create or update a pull request, and squash-merge it
after required checks pass. It must not impose arbitrary file-count or scope limits.

It must never push directly to `main`, force-push, delete branches, expose secrets, weaken tests, or modify
protected repository, workflow, credential, or writer files.
