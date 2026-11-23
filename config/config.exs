# This file is responsible for configuring your application
# and its dependencies with the aid of the Config module.
#
# This configuration file is loaded before any dependency and
# is restricted to this project.

# General application configuration
import Config

config :ex_aws, http_client: ExAws.Request.Req

config :typster, :scopes,
  user: [
    default: true,
    module: Typster.Accounts.Scope,
    assign_key: :current_scope,
    access_path: [:user, :id],
    schema_key: :user_id,
    schema_type: :binary_id,
    schema_table: :users,
    test_data_fixture: Typster.AccountsFixtures,
    test_setup_helper: :register_and_log_in_user
  ]

config :typster,
  ecto_repos: [Typster.Repo],
  generators: [timestamp_type: :utc_datetime, binary_id: true]

# Configures the endpoint
config :typster, TypsterWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [html: TypsterWeb.ErrorHTML, json: TypsterWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: Typster.PubSub,
  live_view: [signing_salt: "UENy6UNS"]

# Configures the mailer
#
# By default it uses the "Local" adapter which stores the emails
# locally. You can see the emails in your browser, at "/dev/mailbox".
#
# For production it's recommended to configure a different adapter
# at the `config/runtime.exs`.
config :typster, Typster.Mailer, adapter: Swoosh.Adapters.Local

# Configure bun
config :bun,
  version: "1.3.11",
  assets: [args: [], cd: Path.expand("../assets", __DIR__)],
  js: [
    args:
      ~w(build js/app.js --outdir=../priv/static/assets/js --external /fonts/* --external /images/*),
    cd: Path.expand("../assets", __DIR__)
  ],
  worker: [
    args:
      ~w(build js/typst_worker_impl.js --outdir=../priv/static/assets/js --external /fonts/* --external /images/*),
    cd: Path.expand("../assets", __DIR__)
  ]

config :phoenix_live_view, :colocated_js,
  target_directory: Path.expand("../assets/node_modules/phoenix-colocated", __DIR__)

# Configure tailwind (the version is required)
config :tailwind,
  version: "4.1.7",
  typster: [
    args: ~w(
      --input=assets/css/app.css
      --output=priv/static/assets/css/app.css
    ),
    cd: Path.expand("..", __DIR__)
  ]

# Configures Elixir's Logger
config :logger, :default_formatter,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

# Use Jason for JSON parsing in Phoenix
config :phoenix, :json_library, Jason

# Configure Oban
config :typster, Oban,
  engine: Oban.Engines.Basic,
  queues: [default: 10],
  repo: Typster.Repo,
  plugins: [
    # Schedule the previously-orphaned background jobs. `config/test.exs` sets
    # `plugins: false`, so Cron never fires during tests.
    {Oban.Plugins.Cron,
     crontab: [
       # Checkpoint each file's content into a revision every 5 minutes.
       {"*/5 * * * *", Typster.Jobs.PeriodicSnapshot},
       # Sweep assets whose project was deleted, daily at 03:00.
       {"0 3 * * *", Typster.Jobs.AssetCleanup}
     ]}
  ]

# Import environment specific config. This must remain at the bottom
# of this file so it overrides the configuration defined above.
import_config "#{config_env()}.exs"
