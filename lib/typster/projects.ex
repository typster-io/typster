defmodule Typster.Projects do
  @moduledoc """
  The Projects context.
  """

  import Ecto.Query, warn: false
  alias Typster.Accounts.Scope
  alias Typster.Repo
  alias Typster.Projects.Project
  alias Typster.Sharing.Collaborator

  def list_projects(%Scope{user: user}) do
    from(p in Project,
      left_join: c in Collaborator,
      on: c.project_id == p.id and c.user_id == ^user.id and c.status == :accepted,
      where: p.user_id == ^user.id or not is_nil(c.id),
      distinct: true,
      order_by: [desc: p.inserted_at]
    )
    |> Repo.all()
  end

  @doc """
  Returns a map of `%{project_id => file_count}` for every project the scope
  can reach — owned or shared as an accepted collaborator.
  """
  def file_counts(%Scope{user: user}) do
    from(f in Typster.Projects.File,
      join: p in Project,
      on: f.project_id == p.id,
      left_join: c in Collaborator,
      on: c.project_id == p.id and c.user_id == ^user.id and c.status == :accepted,
      where: p.user_id == ^user.id or not is_nil(c.id),
      group_by: f.project_id,
      select: {f.project_id, count(f.id)}
    )
    |> Repo.all()
    |> Map.new()
  end

  def get_project!(%Scope{user: user}, id) do
    from(p in Project, where: p.id == ^id and p.user_id == ^user.id)
    |> Repo.one!()
  end

  def get_project(%Scope{user: user}, id) do
    from(p in Project, where: p.id == ^id and p.user_id == ^user.id)
    |> Repo.one()
  end

  @doc """
  Like `get_project!/2` but also grants access to accepted collaborators, not
  just the owner. Use this for **content** access (opening the editor, reading
  and writing files/assets). Project lifecycle (update/delete) and all sharing
  management stay owner-only via `get_project!/2`.
  """
  def get_editable_project!(%Scope{user: user}, id) do
    editable_query(user, id) |> Repo.one!()
  end

  @doc "Non-raising variant of `get_editable_project!/2`."
  def get_editable_project(%Scope{user: user}, id) do
    editable_query(user, id) |> Repo.one()
  end

  defp editable_query(user, id) do
    from(p in Project,
      left_join: c in Collaborator,
      on: c.project_id == p.id and c.user_id == ^user.id and c.status == :accepted,
      where: p.id == ^id and (p.user_id == ^user.id or not is_nil(c.id))
    )
  end

  @doc """
  Returns true when the scope's user owns the project, false for collaborators
  or strangers. Drives owner-only UI affordances (sharing management, delete).
  """
  def owner?(%Scope{user: %{id: user_id}}, %Project{user_id: user_id}), do: true
  def owner?(_scope, _project), do: false

  def create_project(%Scope{user: user}, attrs \\ %{}) do
    %Project{user_id: user.id}
    |> Project.changeset(attrs)
    |> Repo.insert()
  end

  @doc """
  Deep-copies `source` into a brand-new project owned by the scope's user:
  files (with their folder hierarchy) and assets (duplicating the underlying
  S3 objects under fresh keys). Collaborators, the share link, and revision
  history deliberately start clean on the copy.

  Does **not** authorize against `source` — the caller must have already
  established read access (e.g. via a share-link token in
  `Typster.Sharing.fork_via_link/4`, or ownership).

  Options:

    * `:on_progress` — called (inside the fork's process) with `{:files}`
      once the file rows are copied, then `{:assets, copied_bytes,
      total_bytes}` after each asset object lands.

  Returns `{:ok, project}`, `{:error, changeset}` for an invalid name, or
  `{:error, :asset_copy_failed}` when an S3 object copy fails. Either way —
  and also when the calling process is killed mid-copy (Cancel, a closed
  tab) — the transaction rolls back, so no half-copied project is left
  behind. The S3 objects copied before that are removed by a
  `Typster.Jobs.ForkCleanup` safety net enqueued *before* the transaction
  starts (so a rollback can't undo it); it waits while the copy holds the
  fork's advisory lock and does nothing once the fork has committed.
  """
  def fork_project(%Scope{user: user}, %Project{} = source, attrs, opts \\ []) do
    on_progress = Keyword.get(opts, :on_progress, fn _ -> :ok end)
    changeset = Project.changeset(%Project{id: Ecto.UUID.generate(), user_id: user.id}, attrs)

    if changeset.valid? do
      fork_id = Ecto.Changeset.get_field(changeset, :id)
      :ok = Typster.Assets.schedule_fork_cleanup(fork_id, source.id)

      Repo.transaction(fn ->
        Typster.Assets.lock_fork!(fork_id)

        case Repo.insert(changeset) do
          {:ok, fork} -> copy_project_contents!(source.id, fork, on_progress)
          {:error, changeset} -> Repo.rollback(changeset)
        end
      end)
    else
      {:error, %{changeset | action: :insert}}
    end
  end

  # Inside the fork transaction: copy files, then assets; a failed S3 copy
  # rolls the whole fork back.
  defp copy_project_contents!(source_id, fork, on_progress) do
    copy_files!(source_id, fork.id)
    on_progress.({:files})

    case Typster.Assets.copy_project_assets(source_id, fork.id, on_progress) do
      :ok -> fork
      {:error, _reason} -> Repo.rollback(:asset_copy_failed)
    end
  end

  # Copies every file row, then re-links the parent hierarchy through an
  # old-id → new-id map. Two passes (insert flat, then set parents) so the
  # copy never depends on insertion order.
  defp copy_files!(source_id, fork_id) do
    files =
      from(f in Typster.Projects.File,
        where: f.project_id == ^source_id,
        order_by: [asc: f.path]
      )
      |> Repo.all()

    id_map =
      Map.new(files, fn f ->
        copy =
          Repo.insert!(%Typster.Projects.File{
            project_id: fork_id,
            path: f.path,
            content: f.content,
            pinned: f.pinned
          })

        {f.id, copy.id}
      end)

    for f <- files, f.parent_id != nil do
      from(c in Typster.Projects.File, where: c.id == ^Map.fetch!(id_map, f.id))
      |> Repo.update_all(set: [parent_id: Map.fetch!(id_map, f.parent_id)])
    end

    :ok
  end

  def update_project(%Scope{} = scope, %Project{} = project, attrs) do
    project = get_project!(scope, project.id)

    project
    |> Project.changeset(attrs)
    |> Repo.update()
  end

  def delete_project(%Scope{} = scope, %Project{} = project) do
    project = get_project!(scope, project.id)
    Repo.delete(project)
  end

  def change_project(%Project{} = project, attrs \\ %{}) do
    Project.changeset(project, attrs)
  end
end
