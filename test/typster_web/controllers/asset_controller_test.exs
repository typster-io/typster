defmodule TypsterWeb.AssetControllerTest do
  use TypsterWeb.ConnCase, async: true

  import Typster.ProjectsFixtures

  alias Typster.Assets
  alias Typster.Sharing

  @font_bytes File.read!("assets/e2e/fixtures/NotoSansLycian-Regular.ttf")

  setup do
    owner = Typster.AccountsFixtures.user_fixture()
    scope = Typster.Accounts.Scope.for_user(owner)
    project = project_fixture(owner)
    font = stored_asset(project, owner, "Brand.ttf", "font/ttf", @font_bytes)
    image = stored_asset(project, owner, "logo.png", "image/png", <<137, 80, 78, 71>>)
    %{owner: owner, scope: scope, project: project, font: font, image: image}
  end

  describe "GET /projects/:project_id/assets/:id/raw" do
    test "the owner gets the bytes with the asset's content type", %{
      conn: conn,
      owner: owner,
      project: project,
      font: font
    } do
      conn = conn |> log_in_user(owner) |> get(~p"/projects/#{project.id}/assets/#{font.id}/raw")

      assert conn.status == 200
      assert get_resp_header(conn, "content-type") == ["font/ttf"]
      assert get_resp_header(conn, "cache-control") == ["private, max-age=86400"]
      assert conn.resp_body == @font_bytes
    end

    test "a stranger gets 404", %{conn: conn, project: project, font: font} do
      stranger = Typster.AccountsFixtures.user_fixture()

      conn =
        conn |> log_in_user(stranger) |> get(~p"/projects/#{project.id}/assets/#{font.id}/raw")

      assert conn.status == 404
    end

    test "the asset must belong to the project in the path", %{
      conn: conn,
      owner: owner,
      font: font
    } do
      other = project_fixture(owner)
      conn = conn |> log_in_user(owner) |> get(~p"/projects/#{other.id}/assets/#{font.id}/raw")
      assert conn.status == 404
    end

    test "a malformed id is a 404, not a crash", %{conn: conn, owner: owner, project: project} do
      conn = conn |> log_in_user(owner) |> get("/projects/#{project.id}/assets/not-a-uuid/raw")
      assert conn.status == 404
    end

    test "anonymous visitors are sent to log in", %{conn: conn, project: project, font: font} do
      conn = get(conn, ~p"/projects/#{project.id}/assets/#{font.id}/raw")
      assert redirected_to(conn) == ~p"/users/log-in"
    end
  end

  describe "GET /p/:slug/assets/:id" do
    setup %{scope: scope, project: project} do
      %{link: Sharing.get_or_create_link(scope, project.id)}
    end

    test "a valid link key serves a project font", %{
      conn: conn,
      project: project,
      font: font,
      link: link
    } do
      conn = get(conn, ~p"/p/#{Sharing.slug(project)}/assets/#{font.id}?#{[key: link.token]}")
      assert conn.status == 200
      assert get_resp_header(conn, "content-type") == ["font/ttf"]
      assert conn.resp_body == @font_bytes
    end

    test "only fonts are exposed, never other assets", %{
      conn: conn,
      project: project,
      image: image,
      link: link
    } do
      conn = get(conn, ~p"/p/#{Sharing.slug(project)}/assets/#{image.id}?#{[key: link.token]}")
      assert conn.status == 404
    end

    test "a wrong or missing key is a 404", %{conn: conn, project: project, font: font} do
      assert get(conn, ~p"/p/#{Sharing.slug(project)}/assets/#{font.id}?key=nope").status == 404
      assert get(conn, ~p"/p/#{Sharing.slug(project)}/assets/#{font.id}").status == 404
    end

    test "a key for another project cannot read this project's font", %{
      conn: conn,
      owner: owner,
      scope: scope,
      project: project,
      font: font
    } do
      other = project_fixture(owner)
      other_link = Sharing.get_or_create_link(scope, other.id)

      conn =
        get(conn, ~p"/p/#{Sharing.slug(project)}/assets/#{font.id}?#{[key: other_link.token]}")

      assert conn.status == 404
    end
  end

  # An asset row backed by a real object in the bucket (RustFS locally and in CI).
  defp stored_asset(project, owner, filename, content_type, bytes) do
    bucket = Application.get_env(:typster, :s3_bucket, "typster-assets")
    _ = ExAws.S3.put_bucket(bucket, "us-east-1") |> ExAws.request()
    key = "projects/#{project.id}/assets/#{System.unique_integer([:positive])}-#{filename}"

    {:ok, _} =
      ExAws.S3.put_object(bucket, key, bytes, content_type: content_type) |> ExAws.request()

    {:ok, asset} =
      Assets.upload_asset(Typster.Accounts.Scope.for_user(owner), project.id, key, %{
        filename: filename,
        content_type: content_type,
        size: byte_size(bytes)
      })

    asset
  end
end
