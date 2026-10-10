# Agent instructions

- Read `docs/README.md` and the relevant architecture, maintenance, and testing docs before changing behavior.
- Use supported Pi APIs. Keep support limited to the legacy `openai-codex` / `openai-codex-responses` OAuth connection unless explicitly asked otherwise.
- Add meaningful regressions for behavior changes. Run appropriate checks from `package.json`; distinguish local validation from live backend acceptance.
- Update documentation when behavior or compatibility changes.
- Do not inspect credential files, alter global settings, run live inference, commit, push, or publish without explicit permission.
