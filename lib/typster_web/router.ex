defmodule TypsterWeb.Router do
  use TypsterWeb, :router

  import TypsterWeb.UserAuth

  defp set_locale(conn, _opts) do
    locale = get_session(conn, :locale) || "en"
    Gettext.put_locale(TypsterWeb.Gettext, locale)
    conn
  end

  # The embed is meant to be iframed by any origin, so relax just the CSP
  # `frame-ancestors` directive that `put_secure_browser_headers` pins to 'self'.
  # All other secure browser headers (set by that plug above) stay in place.
  defp allow_cross_origin_framing(conn, _opts) do
    put_resp_header(conn, "content-security-policy", "base-uri 'self'; frame-ancestors *")
  end

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {TypsterWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
    plug :fetch_current_scope_for_user
    plug :set_locale
  end

  # Like `:browser`, but allows the response to be framed by any origin —
  # embedding `/embed/:token` on third-party sites is its entire purpose. The
  # default `put_secure_browser_headers` pins `frame-ancestors 'self'`, which
  # blocks cross-origin iframes; we override just that directive here.
  pipeline :embeddable do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {TypsterWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
    plug :allow_cross_origin_framing
    plug :fetch_current_scope_for_user
    plug :set_locale
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  pipeline :api_auth do
    plug :fetch_current_scope_for_api
    plug :require_authenticated_api_user
  end

  scope "/", TypsterWeb do
    pipe_through :browser

    get "/", PageController, :home
    get "/locale/:locale", LocaleController, :set
  end

  scope "/", TypsterWeb do
    pipe_through [:browser, :require_authenticated_user]

    live_session :authenticated,
      on_mount: [
        {TypsterWeb.RestoreLocale, :default},
        {TypsterWeb.UserAuth, :require_authenticated}
      ] do
      live "/projects", ProjectLive.Index
      live "/projects/:id", ProjectLive.Show
      live "/projects/:id/edit", EditorLive.Index
    end
  end

  scope "/api", TypsterWeb.Api, as: :api do
    pipe_through :api

    get "/health", HealthController, :show
    post "/users/log-in", SessionController, :create
  end

  scope "/api", TypsterWeb.Api, as: :api do
    pipe_through [:api, :api_auth]

    delete "/users/log-out", SessionController, :delete

    resources "/projects", ProjectController, except: [:new, :edit] do
      resources "/files", FileController, only: [:index, :create, :update, :delete]
    end
  end

  if Application.compile_env(:typster, :e2e_auth_routes, false) do
    scope "/dev", TypsterWeb do
      pipe_through :browser

      post "/test-login", E2EAuthController, :create
    end
  end

  # Enable LiveDashboard and Swoosh mailbox preview in development
  if Application.compile_env(:typster, :dev_routes) do
    # If you want to use the LiveDashboard in production, you should put
    # it behind authentication and allow only admins to access it.
    # If your application does not have an admins-only section yet,
    # you can use Plug.BasicAuth to set up some basic authentication
    # as long as you are also using SSL (which you should anyway).
    import Phoenix.LiveDashboard.Router

    scope "/dev" do
      pipe_through :browser

      live_dashboard "/dashboard", metrics: TypsterWeb.Telemetry
      forward "/mailbox", Plug.Swoosh.MailboxPreview
    end
  end

  ## Authentication routes

  scope "/", TypsterWeb do
    pipe_through [:browser, :require_authenticated_user]

    live_session :require_authenticated_user,
      on_mount: [
        {TypsterWeb.RestoreLocale, :default},
        {TypsterWeb.UserAuth, :require_authenticated}
      ] do
      live "/users/settings", UserLive.Settings, :edit
      live "/users/settings/confirm-email/:token", UserLive.Settings, :confirm_email
    end

    post "/users/update-password", UserSessionController, :update_password

    # Collaboration invite acceptance. Behind :require_authenticated_user so an
    # unregistered invitee is sent to log-in/registration first, then returned
    # here (via :user_return_to) to link the invite to their account.
    get "/invites/:id", InviteController, :show
  end

  scope "/", TypsterWeb do
    # `store_return_to_param` only acts on GET /users/log-in|register: it
    # remembers a validated local `?return_to=` (the share page's copy modal)
    # so the visitor lands back there after signing in.
    pipe_through [:browser, :store_return_to_param]

    live_session :current_user,
      on_mount: [
        {TypsterWeb.RestoreLocale, :default},
        {TypsterWeb.UserAuth, :mount_current_scope}
      ] do
      live "/users/register", UserLive.Registration, :new
      live "/users/log-in", UserLive.Login, :new
      live "/users/log-in/:token", UserLive.Confirmation, :new

      # Public, read-only shared project view (the link token authorizes).
      live "/p/:slug", SharedProjectLive, :show
    end

    post "/users/log-in", UserSessionController, :create
    delete "/users/log-out", UserSessionController, :delete
  end

  # The embed view is identical to the shared view but framable cross-origin, so
  # it gets the `:embeddable` pipeline and its own `live_session`.
  scope "/", TypsterWeb do
    pipe_through [:embeddable]

    live_session :embed,
      on_mount: [
        {TypsterWeb.RestoreLocale, :default},
        {TypsterWeb.UserAuth, :mount_current_scope}
      ] do
      live "/embed/:token", SharedProjectLive, :embed
    end
  end
end
