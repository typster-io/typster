defmodule TypsterWeb.AssetController do
  @moduledoc """
  Serves asset bytes through the app's own origin.

  The preview compiles in the browser and needs the raw bytes of project fonts.
  Fetching them straight from object storage would be a cross-origin request
  that depends on the bucket's CORS configuration (RustFS and plain S3 send no
  `Access-Control-Allow-Origin` by default), so the worker fetches them from
  here instead and the app reads the object server-side.

  * `show/2` — `/projects/:project_id/assets/:id/raw`, behind
    `:require_authenticated_user`: the owner or an accepted collaborator.
  * `shared/2` — `/p/:slug/assets/:id?key=…`, public: the share-link token
    authorizes, and only fonts are exposed this way.
  """
  use TypsterWeb, :controller

  alias Typster.Assets
  alias Typster.Sharing

  def show(conn, %{"project_id" => project_id, "id" => id}) do
    with {:ok, _} <- Ecto.UUID.cast(id),
         %Assets.Asset{project_id: ^project_id} = asset <-
           Assets.get_asset(conn.assigns.current_scope, id) do
      send_asset(conn, asset)
    else
      _ -> not_found(conn)
    end
  end

  def shared(conn, %{"id" => id} = params) do
    with %Sharing.ShareLink{} = link <- Sharing.get_link_by_token(params["key"]),
         {:ok, _} <- Ecto.UUID.cast(id),
         %Assets.Asset{} = asset <- Assets.get_project_font(link.project_id, id) do
      send_asset(conn, asset)
    else
      _ -> not_found(conn)
    end
  end

  # The content type comes from a fixed table keyed by the file's extension
  # (never from the stored, client-supplied MIME string), the body is binary
  # font/image data, and `nosniff` keeps the browser from guessing otherwise.
  defp send_asset(conn, asset) do
    case Assets.fetch_object(asset) do
      {:ok, body} ->
        conn
        |> put_resp_header("cache-control", "private, max-age=86400")
        |> put_resp_header("x-content-type-options", "nosniff")
        |> send_download({:binary, body},
          filename: asset.filename,
          content_type: Assets.serve_content_type(asset),
          disposition: :inline
        )

      {:error, _reason} ->
        not_found(conn)
    end
  end

  defp not_found(conn), do: send_resp(conn, 404, "Not found")
end
