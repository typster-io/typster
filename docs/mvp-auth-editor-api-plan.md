# Typster MVP Completion Plan

## Summary
Finish the MVP around authenticated project ownership, stable project/file editing, basic JSON endpoints, and the five open GitHub issues: #43, #44, #45, #46, and #47. Use Docker Compose for Postgres/MinIO verification because local Postgres is not assumed to be running.

## Key Changes
- Create and work on `feature/mvp-auth-editor-api`.
- Preserve unrelated uncommitted files unless they directly block the MVP.
- Add full Phoenix auth using `mix phx.gen.auth Accounts User users --live`.
- Protect `/projects`, `/projects/:id`, and `/projects/:id/edit`.
- Pass `current_scope` into all `<Layouts.app ...>` usages that need it.
- Add `user_id` ownership to projects and scope project, file, asset, and revision operations by the authenticated user.
- Add a JSON API with:
  - `GET /api/health`
  - authenticated project CRUD endpoints
  - authenticated file list/create/update/delete endpoints under projects
- Stabilize the editor loop:
  - prefer `main.typ` as the initial file
  - preserve multiline content correctly
  - report `saving`, `saved`, and `error`
  - prevent stale autosave writes after file switches
- Add file classification and BibTeX support:
  - `.typ` and `.bib` are editable text
  - `.pdf`, `.png`, `.jpg`, `.jpeg`, `.svg`, `.webp`, `.ttf`, `.otf`, `.woff`, `.woff2` are assets
  - binary assets must not open in CodeMirror
  - `.bib` editing must not trigger Typst preview compilation
- Add minimal asset upload and listing in the editor sidebar.
- Make preview project-aware enough for MVP by sending project text file and asset metadata into the preview worker, while keeping the current placeholder renderer if full Typst WASM integration is still absent.

## Test Plan
- Start dependencies with `docker compose up -d db rustfs`.
- Run migrations and tests with Mix.
- Add focused coverage for:
  - registration, login, logout, and authenticated route protection
  - project ownership isolation between users
  - JSON health plus authenticated JSON project/file endpoints
  - project and editor LiveView flows
  - file classification and editor behavior for `.typ`, `.bib`, and binary assets
  - asset upload metadata persistence and listing
- Finish with `mix precommit`.

## GitHub And Commits
- Commit in logical slices with the required style:
  - `feat: add user authentication and project ownership (#47)`
  - `feat: stabilize editor and file classification (#43)`
  - `feat: add bibtex editing and project preview data (#44)`
  - `feat: add asset upload and project api endpoints (#46)`
  - `test: cover mvp auth editor and api flows (#47)`
- Push the branch and open a draft PR against `main`.
- Reference `Closes #43`, `Closes #44`, `Closes #45`, `Closes #46`, and `Closes #47` only if the final implementation satisfies those issues and `mix precommit` passes.

## Assumptions
- Use full Phoenix email/password auth.
- Add health plus authenticated project/file JSON endpoints.
- Keep `Req` as the HTTP client; do not add alternatives.
- Use Docker Compose for verification dependencies.
- Do not merge Dependabot PRs as part of this MVP unless one is needed to unblock the work.
