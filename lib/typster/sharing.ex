defmodule Typster.Sharing do
  @moduledoc """
  The Sharing context: public share links and project collaborators.

  Owner-management functions take a `%Scope{}` first and authorize against the
  project owner via `Projects.get_project!/2` (which raises for projects the
  scope's user does not own). Public token resolution does **not** take a scope.
  """

  import Ecto.Query, warn: false

  alias Typster.Accounts.Scope
  alias Typster.Accounts.User
  alias Typster.Projects
  alias Typster.Repo
  alias Typster.Sharing.Collaboration
  alias Typster.Sharing.Collaborator
  alias Typster.Sharing.Notifier
  alias Typster.Sharing.ShareLink

  ## Share links

  @doc """
  Returns the project's share link, creating one with a fresh token and the
  default `:read` scope if none exists yet. Authorizes via the project owner.
  """
  def get_or_create_link(%Scope{} = scope, project_id) do
    project = Projects.get_project!(scope, project_id)

    case Repo.get_by(ShareLink, project_id: project.id) do
      nil ->
        %ShareLink{project_id: project.id, token: ShareLink.gen_token(), scope: :read}
        |> Repo.insert!()

      %ShareLink{} = link ->
        link
    end
  end

  @doc """
  Updates an existing link's `:scope` and/or `:allow_download`. Authorizes the
  link's project against the scope owner before updating.
  """
  def update_link(%Scope{} = scope, %ShareLink{} = link, attrs) do
    _project = Projects.get_project!(scope, link.project_id)

    link
    |> ShareLink.changeset(attrs)
    |> Repo.update()
  end

  @doc """
  Rotates the link's token, invalidating the previous one. Authorizes via owner.
  """
  def rotate_link(%Scope{} = scope, %ShareLink{} = link) do
    _project = Projects.get_project!(scope, link.project_id)

    link
    |> Ecto.Changeset.change(token: ShareLink.gen_token())
    |> Repo.update()
  end

  @doc """
  PUBLIC: resolves a share link by its token, preloading the project.

  Returns `nil` for a blank or unknown token. Takes no scope by design.
  """
  def get_link_by_token(token) when is_binary(token) do
    case String.trim(token) do
      "" ->
        nil

      trimmed ->
        ShareLink
        |> where([l], l.token == ^trimmed)
        |> preload(:project)
        |> Repo.one()
    end
  end

  def get_link_by_token(_token), do: nil

  @doc """
  PUBLIC: the link owner's `Scope`, for entitlement checks on the public/embed
  views (e.g. whether an embed may be an editable sandbox).

  This is strictly the **sharer's** plan, never the anonymous visitor's — the
  embed inherits the capabilities the owner pays for. Returns `nil` when the
  owner can't be resolved.
  """
  @spec owner_scope(ShareLink.t()) :: Scope.t() | nil
  def owner_scope(%ShareLink{} = link) do
    case Repo.preload(link, project: :user) do
      %{project: %{user: %User{} = user}} -> Scope.for_user(user)
      _ -> nil
    end
  end

  @doc """
  Returns a changeset for a share link, for use in forms.
  """
  def change_link(%ShareLink{} = link, attrs \\ %{}) do
    ShareLink.changeset(link, attrs)
  end

  @doc """
  PUBLIC: the source files of a share link's project, path-ordered.

  Takes no scope — the link itself is the authorization. Used to render the
  read-only shared/embedded view (and feed the client-side Typst compiler).
  """
  def files_for_link(%ShareLink{project_id: project_id}) do
    Typster.Projects.File
    |> where([f], f.project_id == ^project_id)
    |> order_by([f], asc: f.path)
    |> Repo.all()
  end

  @doc """
  URL slug for a project's public share page (`/p/:slug`). Cosmetic only —
  the `key` query param is what authorizes the view.
  """
  def slug(%{name: name}) do
    name
    |> String.downcase()
    |> String.replace(~r/[^a-z0-9]+/, "-")
    |> String.trim("-")
    |> case do
      "" -> "project"
      slug -> slug
    end
  end

  @doc """
  PUBLIC: what a fork of the link's project would copy — file and asset counts
  plus total asset bytes. Powers the copy modal's "what you get" meta line.
  """
  def fork_stats(%ShareLink{project_id: project_id}) do
    files =
      Repo.aggregate(
        from(f in Typster.Projects.File, where: f.project_id == ^project_id),
        :count
      )

    {assets, bytes} =
      Repo.one(
        from(a in Typster.Assets.Asset,
          where: a.project_id == ^project_id,
          select: {count(a.id), coalesce(sum(a.size), 0)}
        )
      )

    %{files: files, assets: assets, bytes: bytes}
  end

  ## Link-authorized fork & join

  @doc """
  PUBLIC (token): clones the link's project for the signed-in visitor.

  The token **plus** the link's `allow_fork` policy authorize the copy — no
  project-level access is required (that is the whole point: the visitor is a
  stranger). Free feature; available on every plan.

  Returns `{:ok, project}`, `{:error, changeset}` for a bad name,
  `{:error, :forbidden}` when the owner has not enabled copying,
  `{:error, :not_found}` for an unknown token or anonymous visitor. `opts` are
  passed to `Typster.Projects.fork_project/4` (e.g. `:on_progress`).
  """
  def fork_via_link(scope, token, attrs, opts \\ [])

  def fork_via_link(%Scope{user: %User{}} = scope, token, attrs, opts) when is_binary(token) do
    case get_link_by_token(token) do
      nil ->
        {:error, :not_found}

      %ShareLink{allow_fork: true} = link ->
        Projects.fork_project(scope, link.project, attrs, opts)

      %ShareLink{} ->
        {:error, :forbidden}
    end
  end

  def fork_via_link(_scope, _token, _attrs, _opts), do: {:error, :not_found}

  @doc """
  PUBLIC (token): joins the signed-in visitor as an accepted collaborator on
  the link's project.

  Whether a link may hand out seats is decided by
  `Typster.Sharing.Collaboration` — the Pro-only policy (the link's `open_edit`
  flag **and** the **owner's** `:share_open_collaboration` entitlement; the
  sharer's plan decides, exactly like the embed sandbox). The open-core build
  always denies. Idempotent: re-joining is a no-op success, and a prior
  email invite is simply accepted in place — keeping the role the owner chose
  there rather than force-promoting to `:editor`.

  Returns `{:ok, collaborator}`, `{:ok, :owner}` when the visitor already owns
  the project, `{:error, :forbidden}` when the policy or entitlement is off,
  `{:error, :not_found}` for an unknown token or anonymous visitor.
  """
  def join_via_link(%Scope{user: %User{} = user}, token) when is_binary(token) do
    case get_link_by_token(token) do
      nil ->
        {:error, :not_found}

      %ShareLink{} = link ->
        cond do
          link.project.user_id == user.id ->
            {:ok, :owner}

          not Collaboration.open_edit?(owner_scope(link), link) ->
            {:error, :forbidden}

          true ->
            upsert_link_collaborator(link.project_id, user)
        end
    end
  end

  def join_via_link(_scope, _token), do: {:error, :not_found}

  # Reuses a prior invite row (matched by account or email, so we never trip
  # the [project_id, email] unique index) and accepts it; otherwise inserts a
  # fresh accepted :editor row.
  defp upsert_link_collaborator(project_id, user) do
    email = String.downcase(user.email)

    existing =
      Repo.one(
        from(c in Collaborator,
          where:
            c.project_id == ^project_id and
              (c.user_id == ^user.id or fragment("lower(?)", c.email) == ^email),
          limit: 1
        )
      )

    case existing do
      %Collaborator{status: :accepted, user_id: user_id} = collaborator
      when user_id == user.id ->
        {:ok, collaborator}

      %Collaborator{} = collaborator ->
        collaborator |> Collaborator.accept_changeset(user.id) |> Repo.update()

      nil ->
        %Collaborator{project_id: project_id, user_id: user.id, status: :accepted}
        |> Collaborator.changeset(%{email: user.email, role: :editor})
        |> Repo.insert()
    end
  end

  ## Collaborators

  @doc """
  Lists a project's collaborators, oldest first. Authorizes via the owner.
  """
  def list_collaborators(%Scope{} = scope, project_id) do
    project = Projects.get_project!(scope, project_id)

    Collaborator
    |> where([c], c.project_id == ^project.id)
    |> order_by([c], asc: c.inserted_at)
    |> Repo.all()
  end

  @doc """
  Invites a collaborator by email with the given role (default `:viewer`).

  Inserts a `:pending` collaborator, then delivers an invite email. Delivery
  failures are swallowed so a transient mailer error never fails the invite.
  """
  def invite_collaborator(%Scope{} = scope, project_id, email, role \\ :viewer) do
    project = Projects.get_project!(scope, project_id)

    result =
      %Collaborator{project_id: project.id, status: :pending}
      |> Collaborator.changeset(%{email: email, role: role})
      |> Repo.insert()

    case result do
      {:ok, collaborator} ->
        deliver_invite_quietly(collaborator, project)
        {:ok, collaborator}

      {:error, _changeset} = error ->
        error
    end
  end

  @doc """
  Updates a collaborator's role. Authorizes via the collaborator's project.
  """
  def update_collaborator_role(%Scope{} = scope, %Collaborator{} = collaborator, role) do
    _project = Projects.get_project!(scope, collaborator.project_id)

    collaborator
    |> Collaborator.changeset(%{role: role})
    |> Repo.update()
  end

  @doc """
  Removes a collaborator. Authorizes via the collaborator's project.
  """
  def remove_collaborator(%Scope{} = scope, %Collaborator{} = collaborator) do
    _project = Projects.get_project!(scope, collaborator.project_id)
    Repo.delete(collaborator)
  end

  @doc """
  Returns a changeset for a collaborator, for use in forms.
  """
  def change_collaborator(%Collaborator{} = collaborator, attrs \\ %{}) do
    Collaborator.changeset(collaborator, attrs)
  end

  @doc """
  PUBLIC (bearer): accepts a pending invite for the authenticated user.

  The invite `id` is the bearer credential, but it is **not** sufficient on its
  own: the invite is addressed to a specific email, so we only link it to a user
  whose account email matches that address (case-insensitive). Otherwise anyone
  authenticated — including the project owner clicking the link to "preview" it —
  would silently claim the invite and bind it to the wrong account, leaving the
  real invitee unable to see the project.

  Idempotent: re-accepting an already-accepted invite by the same user is a
  no-op success. Returns `{:ok, collaborator}` with the project preloaded,
  `{:error, :forbidden}` when the invite is for a different email, or
  `{:error, :not_found}` when the id is malformed or no invite exists.
  """
  def accept_invite(%Scope{user: %{id: user_id, email: email}}, invite_id)
      when is_binary(invite_id) do
    with %Collaborator{} = collaborator <- fetch_collaborator(invite_id),
         true <- same_email?(collaborator.email, email),
         {:ok, accepted} <-
           collaborator |> Collaborator.accept_changeset(user_id) |> Repo.update() do
      {:ok, Repo.preload(accepted, :project)}
    else
      nil -> {:error, :not_found}
      false -> {:error, :forbidden}
      {:error, _changeset} = error -> error
    end
  end

  def accept_invite(_scope, _invite_id), do: {:error, :not_found}

  @doc """
  Links every invite addressed to this user's email to their account and marks
  it `:accepted`, so projects shared with them appear in their list **without**
  having to click the email accept-link. The invite *email* is the source of
  truth for who an invite belongs to, so this also self-heals rows that were
  mis-linked to another account. Idempotent; returns the number of rows touched.
  """
  @spec link_invites_for_user(Scope.t()) :: non_neg_integer()
  def link_invites_for_user(%Scope{user: %User{id: user_id, email: email}})
      when is_binary(email) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    {count, _} =
      from(c in Collaborator,
        where:
          fragment("lower(?)", c.email) == ^String.downcase(email) and
            (is_nil(c.user_id) or c.user_id != ^user_id or c.status != :accepted)
      )
      |> Repo.update_all(set: [user_id: user_id, status: :accepted, updated_at: now])

    count
  end

  def link_invites_for_user(_scope), do: 0

  defp same_email?(a, b) when is_binary(a) and is_binary(b),
    do: String.downcase(a) == String.downcase(b)

  defp same_email?(_a, _b), do: false

  defp fetch_collaborator(id) do
    case Ecto.UUID.cast(id) do
      {:ok, uuid} -> Repo.get(Collaborator, uuid)
      :error -> nil
    end
  end

  ## Internal

  defp deliver_invite_quietly(%Collaborator{} = collaborator, project) do
    url = "#{TypsterWeb.Endpoint.url()}/invites/#{collaborator.id}"
    Notifier.deliver_collaborator_invite(collaborator.email, project.name, url)
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end
end
