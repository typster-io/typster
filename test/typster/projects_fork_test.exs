defmodule Typster.ProjectsForkTest do
  use Typster.DataCase, async: true
  use Oban.Testing, repo: Typster.Repo

  import Typster.AccountsFixtures, only: [user_scope_fixture: 0]
  import Typster.ProjectsFixtures

  alias Typster.Assets
  alias Typster.Files
  alias Typster.Jobs.ForkCleanup
  alias Typster.Projects
  alias Typster.Sharing

  setup do
    owner = user_scope_fixture()
    project = project_fixture(owner)
    %{owner: owner, project: project}
  end

  describe "fork_project/4" do
    test "deep-copies files and re-links the hierarchy to the new owner", %{
      owner: owner,
      project: project
    } do
      dir = file_fixture(project, owner, %{path: "chapters", content: nil})

      child =
        file_fixture(project, owner, %{
          path: "chapters/one.typ",
          content: "= One",
          parent_id: dir.id
        })

      visitor = user_scope_fixture()
      assert {:ok, fork} = Projects.fork_project(visitor, project, %{name: "My copy"})

      assert fork.user_id == visitor.user.id
      assert fork.name == "My copy"

      copies = Files.get_file_tree(visitor, fork.id)
      assert length(copies) == 2

      dir_copy = Enum.find(copies, &(&1.path == "chapters"))
      child_copy = Enum.find(copies, &(&1.path == "chapters/one.typ"))

      # Fresh rows with the hierarchy remapped to the copied ids.
      assert dir_copy.id != dir.id
      assert child_copy.id != child.id
      assert child_copy.parent_id == dir_copy.id
      assert child_copy.content == "= One"

      # The source project is untouched and still the original owner's.
      originals = Files.get_file_tree(owner, project.id)
      assert Enum.map(originals, & &1.id) |> Enum.sort() == Enum.sort([dir.id, child.id])
    end

    test "an invalid name rolls the whole fork back", %{owner: owner, project: project} do
      file_fixture(project, owner, %{path: "main.typ", content: "= Hi"})
      visitor = user_scope_fixture()

      assert {:error, %Ecto.Changeset{}} = Projects.fork_project(visitor, project, %{name: ""})
      assert Projects.list_projects(visitor) == []
    end

    test "reports progress in order; asset bytes add up to fork_stats", %{
      owner: owner,
      project: project
    } do
      file_fixture(project, owner, %{path: "main.typ", content: "= Hi"})
      s3_asset(project, owner, "a.png", 1_000)
      s3_asset(project, owner, "b.png", 3_000)
      stats = Sharing.fork_stats(Sharing.get_or_create_link(owner, project.id))

      test_pid = self()
      visitor = user_scope_fixture()

      assert {:ok, fork} =
               Projects.fork_project(visitor, project, %{name: "Copy"},
                 on_progress: &send(test_pid, {:progress, &1})
               )

      assert [{:created, fork_id}, {:files}, {:assets, first, total}, {:assets, 4_000, total}] =
               collect_progress()

      # Asset order is not guaranteed; the running total is.
      assert first in [1_000, 3_000]
      assert fork_id == fork.id
      assert total == stats.bytes

      # Every copied object lives under the fork's own key prefix.
      for asset <- Repo.all(from a in Assets.Asset, where: a.project_id == ^fork.id) do
        assert String.starts_with?(asset.object_key, "projects/#{fork.id}/assets/")
        assert {:ok, _} = ExAws.S3.head_object(bucket(), asset.object_key) |> ExAws.request()
      end
    end

    test "a failed asset copy rolls back and schedules the object cleanup", %{
      owner: owner,
      project: project
    } do
      # An asset row whose S3 object is missing: the copy fails.
      asset_fixture(project, owner)
      visitor = user_scope_fixture()

      assert {:error, :asset_copy_failed} =
               Projects.fork_project(visitor, project, %{name: "Doomed"})

      assert Projects.list_projects(visitor) == []
      assert_enqueued(worker: ForkCleanup, args: %{"source_project_id" => project.id})
    end
  end

  describe "ForkCleanup" do
    test "deletes a rolled-back fork's objects but never a live fork's", %{
      owner: owner,
      project: project
    } do
      asset = s3_asset(project, owner, "c.png", 10)

      # A fork that never committed: its id has no project row.
      ghost_id = Ecto.UUID.generate()
      ghost_key = "projects/#{ghost_id}/assets/#{asset.id}-c.png"

      {:ok, _} =
        ExAws.S3.put_object_copy(bucket(), ghost_key, bucket(), asset.object_key)
        |> ExAws.request()

      args = %{"fork_id" => ghost_id, "source_project_id" => project.id}
      assert :ok = perform_job(ForkCleanup, args)
      assert {:error, _} = ExAws.S3.head_object(bucket(), ghost_key) |> ExAws.request()

      # A committed fork keeps its objects.
      {:ok, fork} = Projects.fork_project(user_scope_fixture(), project, %{name: "Kept"})
      [copy] = Repo.all(from a in Assets.Asset, where: a.project_id == ^fork.id)

      assert :ok =
               perform_job(ForkCleanup, %{"fork_id" => fork.id, "source_project_id" => project.id})

      assert {:ok, _} = ExAws.S3.head_object(bucket(), copy.object_key) |> ExAws.request()
    end
  end

  defp collect_progress(acc \\ []) do
    receive do
      {:progress, event} -> collect_progress([event | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  defp bucket, do: Application.get_env(:typster, :s3_bucket, "typster-assets")

  # An asset backed by a real object in the (MinIO) bucket.
  defp s3_asset(project, owner, filename, size) do
    _ = ExAws.S3.put_bucket(bucket(), "us-east-1") |> ExAws.request()
    key = "projects/#{project.id}/assets/#{System.unique_integer([:positive])}-#{filename}"

    {:ok, _} =
      ExAws.S3.put_object(bucket(), key, :crypto.strong_rand_bytes(size)) |> ExAws.request()

    {:ok, asset} =
      Assets.upload_asset(owner, project.id, key, %{
        filename: filename,
        content_type: "image/png",
        size: size
      })

    asset
  end
end
