defmodule Typster.Assets do
  @moduledoc """
  The Assets context.
  """

  import Ecto.Query, warn: false
  alias Typster.Accounts.Scope
  alias Typster.Assets.Asset
  alias Typster.Jobs.ForkCleanup
  alias Typster.Repo
  alias Typster.Sharing.Collaborator

  def get_asset!(%Scope{user: user}, id) do
    from(a in Asset,
      join: p in assoc(a, :project),
      left_join: c in Collaborator,
      on: c.project_id == p.id and c.user_id == ^user.id and c.status == :accepted,
      where: a.id == ^id and (p.user_id == ^user.id or not is_nil(c.id))
    )
    |> Repo.one!()
  end

  def get_asset(%Scope{user: user}, id) do
    from(a in Asset,
      join: p in assoc(a, :project),
      left_join: c in Collaborator,
      on: c.project_id == p.id and c.user_id == ^user.id and c.status == :accepted,
      where: a.id == ^id and (p.user_id == ^user.id or not is_nil(c.id))
    )
    |> Repo.one()
  end

  def upload_asset(%Scope{} = scope, project_id, object_key, attrs) do
    _project = Typster.Projects.get_editable_project!(scope, project_id)

    %Asset{project_id: project_id, inserted_at: DateTime.utc_now(:second)}
    |> Asset.changeset(
      Map.merge(attrs, %{
        object_key: object_key
      })
    )
    |> Repo.insert()
  end

  def upload_entry(%Scope{} = scope, project_id, %{path: path} = entry) do
    filename = Map.fetch!(entry, :client_name)
    content_type = Map.get(entry, :client_type) || MIME.from_path(filename)
    object_key = object_key(project_id, filename)
    safe_path = safe_upload_path!(path)
    size = File.stat!(safe_path).size
    body = File.read!(safe_path)

    with {:ok, _response} <- put_object(object_key, body, content_type) do
      upload_asset(scope, project_id, object_key, %{
        filename: filename,
        content_type: content_type,
        size: size
      })
    end
  end

  def get_asset_url(%Asset{} = asset) do
    config = ExAws.Config.new(:s3)
    bucket = Application.get_env(:typster, :s3_bucket, "typster-assets")

    ExAws.S3.presigned_url(
      config,
      :get,
      bucket,
      asset.object_key,
      expires_in: 3600
    )
  end

  def delete_asset(%Scope{} = scope, %Asset{} = asset) do
    asset = get_asset!(scope, asset.id)
    bucket = Application.get_env(:typster, :s3_bucket, "typster-assets")

    ExAws.S3.delete_object(bucket, asset.object_key)
    |> ExAws.request()

    Repo.delete(asset)
  end

  def list_assets(%Scope{} = scope, project_id) do
    _project = Typster.Projects.get_editable_project!(scope, project_id)

    from(a in Asset,
      where: a.project_id == ^project_id,
      order_by: [desc: a.inserted_at]
    )
    |> Repo.all()
  end

  def change_asset(%Asset{} = asset, attrs \\ %{}) do
    Asset.changeset(asset, attrs)
  end

  @doc """
  Copies every asset of `source_project_id` into `target_project_id`,
  duplicating each S3 object under a fresh key (forks must not share objects —
  deleting the original would break the copy). Target keys are derived from
  the target project and source asset ids (`fork_object_key/2`), so a fork
  that never commits can be cleaned up from its ids alone.

  `on_progress` is called with `{:assets, copied_bytes, total_bytes}` after
  each object lands.

  No scope: authorization is the caller's job (`Typster.Projects.fork_project/4`
  runs this inside its transaction). Returns `:ok`, or `{:error, reason}` on
  the first failed S3 copy so the caller can roll the fork back.
  """
  def copy_project_assets(source_project_id, target_project_id, on_progress \\ fn _ -> :ok end) do
    bucket = bucket()
    assets = source_assets(source_project_id)
    total = Enum.sum_by(assets, &(&1.size || 0))

    assets
    |> Enum.reduce_while({:ok, 0}, fn asset, {:ok, done} ->
      new_key = fork_object_key(target_project_id, asset)

      case ExAws.S3.put_object_copy(bucket, new_key, bucket, asset.object_key)
           |> ExAws.request() do
        {:ok, _} ->
          Repo.insert!(%Asset{
            project_id: target_project_id,
            object_key: new_key,
            content_type: asset.content_type,
            size: asset.size,
            filename: asset.filename,
            inserted_at: DateTime.utc_now(:second)
          })

          done = done + (asset.size || 0)
          on_progress.({:assets, done, total})
          {:cont, {:ok, done}}

        {:error, reason} ->
          {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, _done} -> :ok
      error -> error
    end
  end

  @doc """
  Schedules `Typster.Jobs.ForkCleanup` to delete the S3 objects a fork of
  `source_project_id` may have copied under `fork_id` — for a fork that was
  cancelled or failed, so its transaction rolled back but the objects stayed.
  The job is a no-op when the fork project exists after all.
  """
  def schedule_fork_cleanup(fork_id, source_project_id, delay_seconds \\ 30) do
    %{"fork_id" => fork_id, "source_project_id" => source_project_id}
    |> ForkCleanup.new(schedule_in: delay_seconds)
    |> Oban.insert()
  end

  @doc """
  Best-effort delete of every object a fork of `source_project_id` into
  `fork_id` would have copied. Missing keys are fine (S3 deletes are
  idempotent). Returns `:ok` or the first `{:error, reason}`.
  """
  def delete_fork_objects(fork_id, source_project_id) do
    bucket = bucket()

    source_project_id
    |> source_assets()
    |> Enum.map(
      &(ExAws.S3.delete_object(bucket, fork_object_key(fork_id, &1))
        |> ExAws.request())
    )
    |> Enum.find(:ok, &match?({:error, _}, &1))
  end

  # Deterministic per (fork, source asset): asset ids are unique, so keys never
  # collide inside a fork, and the cleanup can recompute them.
  defp fork_object_key(target_project_id, %Asset{} = asset) do
    "projects/#{target_project_id}/assets/#{asset.id}-#{safe_name(asset.filename)}"
  end

  defp source_assets(project_id) do
    from(a in Asset, where: a.project_id == ^project_id, order_by: [asc: a.inserted_at])
    |> Repo.all()
  end

  defp bucket, do: Application.get_env(:typster, :s3_bucket, "typster-assets")

  def reference_path(%Asset{} = asset), do: "assets/#{asset.filename}"

  defp safe_upload_path!(path) do
    expanded = Path.expand(path)
    tmp_dir = Path.expand(System.tmp_dir!())

    unless String.starts_with?(expanded, tmp_dir <> "/") do
      raise ArgumentError, "upload path is outside the system temp directory"
    end

    expanded
  end

  defp object_key(project_id, filename) do
    "projects/#{project_id}/assets/#{System.unique_integer([:positive])}-#{safe_name(filename)}"
  end

  defp safe_name(filename) do
    filename
    |> Path.basename()
    |> String.replace(~r/[^A-Za-z0-9._-]/, "-")
  end

  defp put_object(object_key, body, content_type) do
    bucket = Application.get_env(:typster, :s3_bucket, "typster-assets")

    put = fn ->
      ExAws.S3.put_object(bucket, object_key, body, content_type: content_type)
      |> ExAws.request()
    end

    case put.() do
      # Bucket missing (e.g. a fresh MinIO): create it once, then retry.
      {:error, {:http_error, 404, _}} ->
        region = Application.get_env(:ex_aws, :region, "us-east-1")
        _ = ExAws.S3.put_bucket(bucket, region) |> ExAws.request()
        put.()

      result ->
        result
    end
  end
end
