import Config

# config/runtime.exs is executed for all environments, including
# during releases. It is executed after compilation and before the
# system starts, so it is typically used to load production configuration
# and secrets from environment variables or elsewhere. Do not define
# any compile-time configuration in here, as it won't be applied.
# The block below contains prod specific runtime configuration.

# ## Using releases
#
# If you use `mix release`, you need to explicitly enable the server
# by passing the PHX_SERVER=true when you start it:
#
#     PHX_SERVER=true bin/typster start
#
# Alternatively, you can use `mix phx.gen.release` to generate a `bin/server`
# script that automatically sets the env var above.
if System.get_env("PHX_SERVER") do
  config :typster, TypsterWeb.Endpoint, server: true
end

# When running the Phoenix server in test mode (e.g. for E2E tests via Playwright),
# the Ecto sandbox pool rolls back every request's connection. Switch to a regular
# pool so that data created during the test run (users, session tokens) persists
# across requests.
if System.get_env("PHX_SERVER") && config_env() == :test do
  config :typster, Typster.Repo,
    pool: DBConnection.ConnectionPool,
    pool_size: 10

  # Playwright drives the server via http://127.0.0.1:4000 while the global
  # endpoint config keeps url.host: "localhost", so Phoenix' default
  # check_origin rejects the LiveView socket handshake. Disable origin
  # checks for the loopback server — only enabled when the server is
  # actually booted under MIX_ENV=test (i.e. by the E2E web server).
  config :typster, TypsterWeb.Endpoint, check_origin: false
end

if config_env() == :prod do
  database_url =
    System.get_env("DATABASE_URL") ||
      raise """
      environment variable DATABASE_URL is missing.
      For example: ecto://USER:PASS@HOST/DATABASE
      """

  maybe_ipv6 = if System.get_env("ECTO_IPV6") in ~w(true 1), do: [:inet6], else: []

  config :typster, Typster.Repo,
    # ssl: true,
    url: database_url,
    pool_size: String.to_integer(System.get_env("POOL_SIZE") || "10"),
    # For machines with several cores, consider starting multiple pools of `pool_size`
    # pool_count: 4,
    socket_options: maybe_ipv6

  # The secret key base is used to sign/encrypt cookies and other secrets.
  # A default value is used in config/dev.exs and config/test.exs but you
  # want to use a different value for prod and you most likely don't want
  # to check this value into version control, so we use an environment
  # variable instead.
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      You can generate one by calling: mix phx.gen.secret
      """

  host = System.get_env("PHX_HOST") || "example.com"
  port = String.to_integer(System.get_env("PORT") || "4000")

  config :typster, :dns_cluster_query, System.get_env("DNS_CLUSTER_QUERY")

  config :typster, TypsterWeb.Endpoint,
    url: [host: host, port: 443, scheme: "https"],
    http: [
      # Enable IPv6 and bind on all interfaces.
      # Set it to  {0, 0, 0, 0, 0, 0, 0, 1} for local network only access.
      # See the documentation on https://hexdocs.pm/bandit/Bandit.html#t:options/0
      # for details about using IPv6 vs IPv4 and loopback vs public addresses.
      ip: {0, 0, 0, 0, 0, 0, 0, 0},
      port: port
    ],
    secret_key_base: secret_key_base

  # ## SSL Support
  #
  # To get SSL working, you will need to add the `https` key
  # to your endpoint configuration:
  #
  #     config :typster, TypsterWeb.Endpoint,
  #       https: [
  #         ...,
  #         port: 443,
  #         cipher_suite: :strong,
  #         keyfile: System.get_env("SOME_APP_SSL_KEY_PATH"),
  #         certfile: System.get_env("SOME_APP_SSL_CERT_PATH")
  #       ]
  #
  # The `cipher_suite` is set to `:strong` to support only the
  # latest and more secure SSL ciphers. This means old browsers
  # and clients may not be supported. You can set it to
  # `:compatible` for wider support.
  #
  # `:keyfile` and `:certfile` expect an absolute path to the key
  # and cert in disk or a relative path inside priv, for example
  # "priv/ssl/server.key". For all supported SSL configuration
  # options, see https://hexdocs.pm/plug/Plug.SSL.html#configure/1
  #
  # We also recommend setting `force_ssl` in your config/prod.exs,
  # ensuring no data is ever sent via http, always redirecting to https:
  #
  #     config :typster, TypsterWeb.Endpoint,
  #       force_ssl: [hsts: true]
  #
  # Check `Plug.SSL` for all available options in `force_ssl`.

  # ## Configuring the mailer
  #
  # In production you need to configure the mailer to use a different adapter.
  # Here is an example configuration for Mailgun:
  #
  #     config :typster, Typster.Mailer,
  #       adapter: Swoosh.Adapters.Mailgun,
  #       api_key: System.get_env("MAILGUN_API_KEY"),
  #       domain: System.get_env("MAILGUN_DOMAIN")
  #
  # Most non-SMTP adapters require an API client. Swoosh supports Req, Hackney,
  # and Finch out-of-the-box. This configuration is typically done at
  # compile-time in your config/prod.exs:
  #
  #     config :swoosh, :api_client, Swoosh.ApiClient.Req
  #
  # See https://hexdocs.pm/swoosh/Swoosh.html#module-installation for details.

  # Configure S3 (AWS or any S3-compatible store) for production
  config :ex_aws,
    access_key_id:
      System.get_env("AWS_ACCESS_KEY_ID") ||
        raise("environment variable AWS_ACCESS_KEY_ID is missing"),
    secret_access_key:
      System.get_env("AWS_SECRET_ACCESS_KEY") ||
        raise("environment variable AWS_SECRET_ACCESS_KEY is missing"),
    region: System.get_env("AWS_REGION") || "us-east-1"

  config :typster,
    s3_bucket:
      System.get_env("S3_BUCKET") ||
        raise("environment variable S3_BUCKET is missing"),
    s3_endpoint: System.get_env("S3_ENDPOINT")

  # Configure S3 endpoint - handle both custom endpoints (RustFS, MinIO, …) and standard AWS S3
  s3_endpoint = System.get_env("S3_ENDPOINT")

  if s3_endpoint do
    # Custom S3-compatible endpoint (e.g., RustFS)
    parsed = URI.parse(s3_endpoint)
    scheme = parsed.scheme || "https"
    host = parsed.host || parsed.authority || s3_endpoint
    port = if parsed.port, do: parsed.port, else: nil

    s3_config = [
      scheme: "#{scheme}://",
      host: host,
      path_style: true
    ]

    s3_config = if port, do: Keyword.put(s3_config, :port, port), else: s3_config

    config :ex_aws, :s3, s3_config
  else
    # Standard AWS S3 - no custom endpoint configuration needed
    # ex_aws will use default AWS S3 endpoints
  end
end

# Configure S3 for all environments (defaults match the RustFS service in docker-compose)
if config_env() != :prod do
  config :ex_aws,
    access_key_id: System.get_env("AWS_ACCESS_KEY_ID") || "rustfsadmin",
    secret_access_key: System.get_env("AWS_SECRET_ACCESS_KEY") || "rustfsadmin",
    region: System.get_env("AWS_REGION") || "us-east-1"

  s3_endpoint = System.get_env("S3_ENDPOINT") || "http://localhost:9000"

  config :typster,
    s3_bucket: System.get_env("S3_BUCKET") || "typster-assets",
    s3_endpoint: s3_endpoint

  parsed = URI.parse(s3_endpoint)
  scheme = parsed.scheme || "http"
  host = parsed.host || parsed.authority || "localhost"
  port = parsed.port

  s3_config = [
    scheme: "#{scheme}://",
    host: host,
    path_style: true
  ]

  s3_config = if port, do: Keyword.put(s3_config, :port, port), else: s3_config

  config :ex_aws, :s3, s3_config
end
