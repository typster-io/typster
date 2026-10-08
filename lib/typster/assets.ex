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

  ## Kinds & the preview manifest

  # Font formats Typst's compiler reads. WOFF/WOFF2 are accepted as uploads
  # (people have them) but Typst cannot load them, so they get their own kind
  # and the editor says so instead of silently ignoring them.
  @font_extensions ~w(.ttf .otf .ttc .otc)
  @web_font_extensions ~w(.woff .woff2)
  @image_extensions ~w(.png .jpg .jpeg .gif .svg .webp)

  @typedoc "Coarse asset classification used by the editor and the preview."
  @type kind :: :font | :web_font | :image | :other

  @doc "Classify an asset (or a bare filename) by extension."
  @spec kind(Asset.t() | String.t()) :: kind()
  def kind(%Asset{filename: filename}), do: kind(filename)

  def kind(filename) when is_binary(filename) do
    case filename |> Path.extname() |> String.downcase() do
      ext when ext in @font_extensions -> :font
      ext when ext in @web_font_extensions -> :web_font
      ext when ext in @image_extensions -> :image
      _ -> :other
    end
  end

  @doc """
  The MIME type to serve an asset's bytes with, from a fixed table keyed by
  extension — never the client-supplied `content_type` stored on upload.
  """
  @serve_content_types %{
    ".ttf" => "font/ttf",
    ".otf" => "font/otf",
    ".ttc" => "font/collection",
    ".otc" => "font/collection",
    ".woff" => "font/woff",
    ".woff2" => "font/woff2",
    ".png" => "image/png",
    ".jpg" => "image/jpeg",
    ".jpeg" => "image/jpeg",
    ".gif" => "image/gif",
    ".svg" => "image/svg+xml",
    ".webp" => "image/webp",
    ".pdf" => "application/pdf"
  }

  @spec serve_content_type(Asset.t() | String.t()) :: String.t()
  def serve_content_type(%Asset{filename: filename}), do: serve_content_type(filename)

  def serve_content_type(filename) when is_binary(filename) do
    ext = filename |> Path.extname() |> String.downcase()
    Map.get(@serve_content_types, ext, "application/octet-stream")
  end

  @doc "True for a font Typst can register (TTF/OTF/TTC/OTC)."
  @spec font?(Asset.t() | String.t()) :: boolean()
  def font?(asset_or_name), do: kind(asset_or_name) == :font

  @doc """
  What the client-side preview needs to know about a project's assets.

  Every asset is listed with its kind; fonts additionally carry a `url` the
  preview worker fetches to register the bytes with the compiler. The caller
  supplies `font_url`, a function from asset to URL, so each view points at
  its own same-origin route (`TypsterWeb.AssetController`) — fetching from
  object storage directly would hinge on the bucket's CORS setup. Without a
  builder, fonts are listed but not registrable.
  """
  @spec preview_manifest([Asset.t()], (Asset.t() -> String.t() | nil)) :: [map()]
  def preview_manifest(assets, font_url \\ fn _asset -> nil end) do
    Enum.map(assets, fn %Asset{} = asset ->
      kind = kind(asset)

      entry = %{
        filename: asset.filename,
        reference_path: reference_path(asset),
        content_type: asset.content_type,
        size: asset.size,
        kind: Atom.to_string(kind)
      }

      with :font <- kind, url when is_binary(url) <- font_url.(asset) do
        Map.put(entry, :url, url)
      else
        _ -> entry
      end
    end)
  end

  @doc "PUBLIC (token-authorized caller): one font of a project, or nil."
  @spec get_project_font(Ecto.UUID.t(), Ecto.UUID.t()) :: Asset.t() | nil
  def get_project_font(project_id, id) do
    case Repo.get_by(Asset, id: id, project_id: project_id) do
      %Asset{} = asset -> if font?(asset), do: asset
      nil -> nil
    end
  end

  @doc "Read an asset's bytes from object storage."
  @spec fetch_object(Asset.t()) :: {:ok, binary()} | {:error, term()}
  def fetch_object(%Asset{object_key: key}) do
    case ExAws.S3.get_object(bucket(), key) |> ExAws.request() do
      {:ok, %{body: body}} -> {:ok, body}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  PUBLIC: the fonts of a project, for the token-authorized share page and
  embed. Those views compile client-side too, so a shared document needs its
  fonts to render faithfully; nothing but fonts is exposed this way.
  """
  @spec list_project_fonts(Ecto.UUID.t()) :: [Asset.t()]
  def list_project_fonts(project_id) do
    from(a in Asset, where: a.project_id == ^project_id, order_by: [asc: a.filename])
    |> Repo.all()
    |> Enum.filter(&font?/1)
  end

  @doc """
  Copies every asset of `source_project_id` into `target_project_id`,
  duplicating each S3 object under a fresh key (forks must not share objects —
  deleting the original would break the copy). Target keys are derived from
  the target project and source asset ids (`fork_object_key/2`), so the
  cleanup safety net can list them before the copy starts.

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
  Enqueues the `Typster.Jobs.ForkCleanup` safety net for a fork of
  `source_project_id` into `fork_id`, *before* the copy starts and outside
  its transaction (so a rollback, a crash or a killed caller can't undo it).

  The job args carry the exact keys the copy may write, snapshotted now from
  the source's assets — so source assets deleted or renamed meanwhile (or a
  deleted source project) can't hide an orphaned object from the cleanup.
  No job when the source has no assets: there is nothing to orphan.
  """
  def schedule_fork_cleanup(fork_id, source_project_id, delay_seconds \\ 60) do
    case Enum.map(source_assets(source_project_id), &fork_object_key(fork_id, &1)) do
      [] ->
        :ok

      keys ->
        %{"fork_id" => fork_id, "object_keys" => keys}
        |> ForkCleanup.new(schedule_in: delay_seconds)
        |> Oban.insert!()

        :ok
    end
  end

  @doc """
  Takes the fork's transaction-scoped advisory lock. `fork_project/4` holds
  it for the whole copy; `try_lock_fork/1` tells the cleanup job whether a
  copy is still in flight.
  """
  def lock_fork!(fork_id) do
    Repo.query!("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [fork_id])
    :ok
  end

  @doc "Non-blocking `lock_fork!/1`: `true` when no copy holds the lock. Call inside a transaction."
  def try_lock_fork(fork_id) do
    %{rows: [[locked?]]} =
      Repo.query!("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))", [fork_id])

    locked?
  end

  @doc """
  Best-effort delete of the given fork object keys. Missing keys are fine
  (S3 deletes are idempotent). Returns `:ok` or the first `{:error, reason}`.
  """
  def delete_fork_objects(object_keys) do
    bucket = bucket()

    object_keys
    |> Enum.map(&(ExAws.S3.delete_object(bucket, &1) |> ExAws.request()))
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

  def reference_path(%Asset{} = asset), do: "#{reference_dir()}/#{asset.filename}"

  @doc "The virtual folder Typst sources reference uploaded assets under."
  def reference_dir, do: "assets"

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
      # Bucket missing (e.g. a fresh RustFS): create it once, then retry.
      {:error, {:http_error, 404, _}} ->
        region = Application.get_env(:ex_aws, :region, "us-east-1")
        _ = ExAws.S3.put_bucket(bucket, region) |> ExAws.request()
        put.()

      result ->
        result
    end
  end
end
