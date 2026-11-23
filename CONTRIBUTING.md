# Contributing to Typster

Thank you for contributing. This guide covers everything you need to get productive: the dev workflow, tooling, commit conventions, and design system.

---

## Table of contents

- [Contributing to Typster](#contributing-to-typster)
  - [Table of contents](#table-of-contents)
  - [Dev environment](#dev-environment)
    - [Without Pixi (manual)](#without-pixi-manual)
    - [Dev Container (alternative)](#dev-container-alternative)
  - [Project structure](#project-structure)
  - [Running the stack](#running-the-stack)
  - [Tooling](#tooling)
    - [Pixi](#pixi)
    - [prek](#prek)
    - [Bun](#bun)
    - [Playwright](#playwright)
    - [ast-index](#ast-index)
  - [Code style](#code-style)
    - [Elixir](#elixir)
    - [JS / TS / CSS](#js--ts--css)
  - [Translations](#translations)
  - [Commit conventions](#commit-conventions)
    - [Format](#format)
    - [Types](#types)
    - [Scope](#scope)
    - [Enforced regex](#enforced-regex)
    - [Examples](#examples)
  - [Design system](#design-system)
    - [Key tokens](#key-tokens)
    - [Component classes](#component-classes)
    - [Themes](#themes)
    - [Typography](#typography)

---

## Dev environment

Install [Pixi](https://pixi.sh) — it manages the complete toolchain (Elixir, Erlang, Bun, prek) from the `pixi.lock` file:

```bash
curl -fsSL https://pixi.sh/install.sh | bash
```

Start the backing services:

```bash
docker compose up -d
```

Then set up and run:

```bash
pixi run setup      # install deps, create and migrate db, build assets
pixi run runserver  # start the phoenix server
```

### Without Pixi (manual)

If you'd rather manage the toolchain yourself, install the following:

| Tool | Version | Install |
|---|---|---|
| Elixir | ≥ 1.19 | [elixir-lang.org](https://elixir-lang.org/install.html) |
| Erlang/OTP | ≥ 28 | bundled with Elixir installers |
| Bun | ≥ 1.3 | [bun.sh](https://bun.sh) |
| prek | latest | [github.com/j178/prek](https://github.com/j178/prek) |

Start the backing services, then set up and run:

```bash
docker compose up -d
mix setup
mix phx.server
```

### Dev Container (alternative)

If you prefer a fully containerised environment, use the included Dev Container with VS Code or GitHub Codespaces.

1. Install the [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) extension.
2. Open the repo in VS Code and click **Reopen in Container**.
3. The `post-create` command runs automatically:
   ```bash
   mix deps.get && mix assets.setup && mix ecto.setup
   ```
4. Start the server: `mix phx.server`

The container comes with ElixirLS, Phoenix Framework, Tailwind CSS IntelliSense, and TypeScript extensions pre-installed. PostgreSQL runs as a sidecar service (`db`) and is reachable at that hostname from inside the container.

---

## Project structure

```
lib/typster/          # Business logic contexts (Accounts, Projects, Files, …)
lib/typster_web/      # Phoenix controllers, LiveViews, components
assets/               # Frontend: CSS, JS, Playwright E2E tests
  css/                # app.css — design tokens, component styles
  js/                 # JS entry points
  e2e/                # Playwright test specs
priv/repo/            # Ecto migrations & seeds
priv/static/          # Compiled & digested static assets
config/               # Elixir environment configs (dev, test, prod, runtime)
docs/                 # Design docs and planning notes
test/                 # ExUnit tests
```

---

## Running the stack

| Task | Command |
|---|---|
| Start server (with Pixi) | `pixi run runserver` |
| Start server (manual) | `mix phx.server` |
| Interactive shell | `iex -S mix phx.server` |
| Run Elixir tests | `mix test` |
| Run E2E tests (Pixi) | `pixi run test-e2e-theme` |
| Run E2E tests (manual) | `cd assets && bun run test:e2e` |
| Full pre-commit check | `mix precommit` |

---

## Tooling

### Pixi

[Pixi](https://pixi.sh) is the project's package manager. It uses conda-forge and a custom channel (`prefix.dev/benzlokzik-public`) to pin every binary dependency in `pixi.lock`. Running `pixi run <task>` activates the correct environment automatically — no `nvm`, `asdf`, or `mise` needed.

Available tasks (defined in `pixi.toml`):

| Task | Description |
|---|---|
| `pixi run setup` | `mix setup` — install deps, create and migrate DB, build assets |
| `pixi run runserver` | `mix phx.server` |
| `pixi run test-e2e-theme` | Run Playwright theme stability tests |

### prek

[prek](https://github.com/j178/prek) is a fast, Rust-written replacement for `pre-commit`. It is installed automatically via Pixi from the custom channel. Hooks are defined in [`.pre-commit-config.yaml`](.pre-commit-config.yaml) and run on every commit.

To run hooks manually:

```bash
prek run --all-files
```

or to install the git hooks:

```bash
prek install
```

### Bun

[Bun](https://bun.sh) is the JavaScript runtime and package manager for the `assets/` directory — for frontend. It handles dependency installation, asset bundling, running tests etc.

```bash
cd assets

bun install                # install js dependencies
bun run build              # build css + js for development
bun run deploy             # minify + digest for production
bun run test:e2e           # run all playwright tests
bun run test:e2e:theme     # run theme-specific playwright tests
bun run stylelint          # lint css
```

### Playwright

End-to-end tests live in `assets/e2e/` and run with Playwright against Chromium.

Configuration: `assets/playwright.config.mjs`

- Base URL: `http://127.0.0.1:4000`
- Playwright auto-starts `mix phx.server` on the first local run (reuses an existing server if one is running).
- In CI, the server is always started fresh.
- Traces are saved on failure for debugging.
- `typst_packages.spec.mjs` downloads Typst Universe packages from `packages.typst.org`, so it needs network access, and an outage there fails it.

```bash
# run all e2e tests
cd assets && bun run test:e2e

# view a playwright trace report
cd assets && bunx playwright show-report
```

### ast-index

[ast-index](https://github.com/defendend/Claude-ast-index-search) provides fast, structured code search across the codebase. Configuration is in `.ast-index.yaml`.

```bash
# search for a symbol
ast-index search MyModule.function_name

# show the project map
ast-index map
```

Used for code navigation, finding usages, and understanding module dependencies. Mostly for AI agents. Installed as instrument in [.claude/](.claude/)

---

## Code style

### Elixir

- Format: `mix format` (config in `.formatter.exs`)
- Lint: `mix credo --strict` (config in `.credo.exs`)
- The `mix precommit` alias runs both, plus compile checks and tests.

### JS / TS / CSS

TODO

---

## Translations

Typster uses Phoenix/Gettext through `TypsterWeb.Gettext`.

- Supported locales are `en` and `ru`
- Catalogs live in `priv/gettext/<locale>/LC_MESSAGES/`
- Template files live in `priv/gettext/*.pot`
- Browser locale is stored in the session and switched through `/locale/:locale`
- The browser pipeline defaults to `en` when no locale is set

When adding or changing user-facing text in Elixir, HEEx, LiveView, or components:

1. Wrap UI strings in `gettext/1`, `gettext/2`, or `ngettext/3`
2. Prefer stable dotted keys for application UI, such as `editor.compile` or `projects.index.title`
3. Use interpolation instead of string concatenation:
   ```elixir
   gettext("common.created_date", date: formatted_date)
   ```
4. Use `ngettext/3` for plural text:
   ```elixir
   ngettext("project.files.count.one", "project.files.count.other", count)
   ```
5. Keep variables identical across all locales
6. Run extraction and merge after changing gettext keys:
   ```bash
   mix gettext.extract --merge
   ```
7. Fill both English and Russian `msgstr` values before handing off
8. Do not edit generated `msgid` values directly in `.po` files; change the source `gettext` call, then re-run extraction
9. Run `mix format` if Elixir or HEEx files changed, then run the relevant tests

When adding a new locale, add a new `priv/gettext/<locale>/LC_MESSAGES/` catalog set, update the supported locale list in `lib/typster_web/controllers/locale_controller.ex`, and verify the locale toggle or navigation path still works.

---

## Commit conventions

All commits on `main` must follow [Conventional Commits](https://www.conventionalcommits.org)

### Format

```
<type>(<scope>)?: <description>

[optional body]

[optional footer(s)]
```

A breaking change is indicated with `!` after the type/scope:

```
feat(auth)!: replace session tokens with JWTs
```

### Types

| Type | When to use |
|---|---|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `style` | Formatting, whitespace — no logic change |
| `refactor` | Code change that is not a fix or feature |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `build` | Build system or external dependency changes |
| `ci` | CI configuration changes |
| `chore` | Maintenance tasks (lockfile bumps, cleanup) |
| `revert` | Revert a previous commit |

### Scope

Optional. Use lowercase kebab-case, matching a context, module, or area:

```
feat(editor): support multi-cursor selection
fix(auth): clear session on password change
chore(deps): bump pixi lockfile
```

### Enforced regex

```
^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-zA-Z0-9\-._]+\))?(!)?: [A-Za-z0-9][^\.\n]*(\([^)]+\): [A-Za-z0-9][^\.\n]*(\([^)]+\))?)?(\.\.\.)?(\\n[\s\S]*)?$
```

### Examples

```
feat(auth): add email verification flow
fix(editor): prevent crash on empty document
docs: add contributing guide
chore(deps): bump pixi lockfile
ci: run all e2e tests
refactor(projects): extract file classification logic
test(api): add health endpoint assertions
```

Full specification: https://www.conventionalcommits.org

---

## Design system

The visual language is documented in `docs/landing-style.md`. All design tokens are CSS custom properties prefixed `--mk-*`, defined in `assets/css/app.css`.

### Key tokens

| Token | Value | Use |
|---|---|---|
| `--mk-pri` | `#4f46e5` (indigo) | Primary actions, links |
| `--mk-bg` | surface background | Page background |
| `--mk-fg` | foreground text | Body text |
| `--mk-radius` | border radius scale | Cards, inputs, buttons |

### Component classes

| Class | Component |
|---|---|
| `.mk-btn` | Button (primary, ghost, outline variants) |
| `.mk-pill` | Tag / label pill |
| `.mk-badge` | Status badge |
| `.mk-alert` | Alert / callout block |
| `.mk-toast` | Toast notification |
| `.mk-dialog` | Modal dialog |

### Themes

Typster ships a light theme and a dark theme. The theme transition uses a CSS animation called "the pour" — a circular clip-path reveal. Do not add inline `color` or `background` values; use tokens so both themes work automatically.

### Typography

- Body: **Inter** (system-grade grotesk)
- Display: **Instrument Serif** (editorial italic, for marketing headings)
- Minimum body font size: 14px. Minimum contrast: 4.5:1 (WCAG AA).

Refer to [`docs/landing-redesign-guide.md`](./docs/landing-redesign-guide.md) for the full aesthetic direction.
