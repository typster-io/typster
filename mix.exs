defmodule Typster.MixProject do
  use Mix.Project

  def project do
    [
      app: :typster,
      version: "0.1.0",
      elixir: "~> 1.19",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      aliases: aliases(),
      deps: deps(),
      compilers: [:phoenix_live_view] ++ Mix.compilers(),
      listeners: [Phoenix.CodeReloader],
      assay: [
        dialyzer: [
          apps: :project_plus_deps,
          warning_apps: :project
        ]
      ]
    ]
  end

  # Configuration for the OTP application.
  #
  # Type `mix help compile.app` for more information.
  def application do
    [
      mod: {Typster.Application, []},
      extra_applications: [:logger, :runtime_tools, :crypto]
    ]
  end

  def cli do
    [
      preferred_envs: [precommit: :test]
    ]
  end

  # Specifies which paths to compile per environment.
  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  # Specifies your project dependencies.
  #
  # Type `mix help deps` for examples and options.
  defp deps do
    [
      {:bcrypt_elixir, "~> 3.0"},
      {:phoenix, "~> 1.8.0"},
      {:phoenix_ecto, "~> 4.5"},
      {:ecto_sql, "~> 3.13"},
      {:postgrex, ">= 0.0.0"},
      {:phoenix_html, "~> 4.1"},
      {:phoenix_live_reload, "~> 1.2", only: :dev},
      {:phoenix_live_view, "~> 1.1.0"},
      {:lazy_html, ">= 0.1.0", only: :test},
      {:phoenix_live_dashboard, "~> 0.9.1"},
      {:bun, "~> 2.0", runtime: Mix.env() == :dev},
      {:tailwind, "~> 0.3", runtime: Mix.env() == :dev},
      {:heroicons,
       github: "tailwindlabs/heroicons",
       tag: "v2.2.0",
       sparse: "optimized",
       app: false,
       compile: false,
       depth: 1},
      {:swoosh, "~> 1.16"},
      {:req, "~> 0.5"},
      {:telemetry_metrics, "~> 1.0"},
      {:telemetry_poller, "~> 1.0"},
      {:gettext, "~> 1.0"},
      {:jason, "~> 1.2"},
      {:dns_cluster, "~> 0.3.0"},
      {:bandit, "~> 1.5"},
      {:oban, "~> 2.17"},
      {:y_ex, "~> 0.10"},
      # Lets y_ex's NIF build from Rust source where no precompiled binary
      # exists for the target (e.g. CI's conda/Pixi triple) — see CI env
      # RUSTLER_PRECOMPILED_FORCE_BUILD_ALL.
      {:rustler, ">= 0.0.0", optional: true},
      {:ex_aws, "~> 2.5"},
      {:ex_aws_s3, "~> 2.5"},
      {:hackney, "~> 1.20"},
      {:salad_ui, "~> 1.0.0-beta.3"},
      {:credo, "~> 1.7.0-rc.1", only: [:dev, :test], runtime: false},
      {:sobelow, "~> 0.14", only: [:dev, :test], runtime: false},
      {:igniter, "~> 0.6", runtime: false},
      {:assay, "~> 0.5", only: [:dev, :test], runtime: false}
    ] ++ pro_deps()
  end

  # Closed-source "Pro" modules live in the private `typster-pro` repo, mounted
  # here as a git submodule at `vendor/pro/` and consumed as a path dependency —
  # but ONLY when present. A plain public clone (or CI without access) leaves
  # `vendor/pro/` empty, so the dependency is never declared and the open-core
  # build compiles cleanly under `--warning-as-errors`. Path deps never enter
  # `mix.lock`, so `deps.unlock --unused` in `precommit` has nothing to strip.
  # The host dispatches to `Typster.Pro.*` at runtime via `Code.ensure_loaded?/1`
  # (see `Typster.Features`), never at compile time.
  defp pro_deps do
    if File.exists?("vendor/pro/mix.exs") do
      [{:typster_pro, path: "vendor/pro"}]
    else
      []
    end
  end

  # Aliases are shortcuts or tasks specific to the current project.
  # For example, to install project dependencies and perform other setup tasks, run:
  #
  #     $ mix setup
  #
  # See the documentation for `Mix` for more info on aliases.
  defp aliases do
    [
      setup: ["deps.get", "assets.setup", "ecto.setup", "assets.build"],
      "ecto.setup": ["ecto.create", "ecto.migrate", &migrate_pro/1, "run priv/repo/seeds.exs"],
      "ecto.reset": ["ecto.drop", "ecto.setup"],
      test: ["ecto.create --quiet", "ecto.migrate --quiet", &migrate_pro/1, "test"],
      "assets.setup": [
        "bun.install --if-missing",
        "bun assets install",
        "tailwind.install --if-missing"
      ],
      "assets.build": ["compile", "tailwind typster", "bun js", "bun worker", "copy_wasm"],
      "assets.deploy": [
        "tailwind typster --minify",
        "bun js --minify",
        "bun worker --minify",
        "copy_wasm",
        "phx.digest"
      ],
      copy_wasm: [
        "cmd mkdir -p priv/static/assets/js",
        "cmd cp assets/node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm priv/static/assets/js/",
        "cmd cp assets/node_modules/@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm priv/static/assets/js/"
      ],
      precommit: [
        "compile --warning-as-errors",
        "deps.unlock --unused",
        "format",
        "sobelow --skip",
        "test"
      ]
    ]
  end

  # The Pro app (`vendor/pro`) ships its own Ecto migrations for its feature
  # tables (e.g. `pro_share_opens`). They run against the host repo, right after
  # the host's own migrations. No-op for a plain open-core checkout where the
  # submodule is absent — so the community build never gains Pro tables.
  defp migrate_pro(_args) do
    path = "vendor/pro/priv/repo/migrations"

    if File.dir?(path) do
      Mix.Task.rerun("ecto.migrate", ["--quiet", "--migrations-path", path])
    end
  end
end
