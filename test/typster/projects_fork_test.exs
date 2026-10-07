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

      assert [{:files}, {:assets, first, total}, {:assets, 4_000, total}] = collect_progress()

      # Asset order is not guaranteed; the running total is.
      assert first in [1_000, 3_000]
      assert total == stats.bytes

      # Every copied object lives under the fork's own key prefix.
      for asset <- Repo.all(from a in Assets.Asset, where: a.project_id == ^fork.id) do
        assert String.starts_with?(asset.object_key, "projects/#{fork.id}/assets/")
        assert {:ok, _} = ExAws.S3.head_object(bucket(), asset.object_key) |> ExAws.request()
      end
    end

    test "a failed asset copy rolls back, leaving the object cleanup enqueued", %{
      owner: owner,
      project: project
    } do
      # An asset row whose S3 object is missing: the copy fails.
      asset = asset_fixture(project, owner)
      visitor = user_scope_fixture()

      assert {:error, :asset_copy_failed} =
               Projects.fork_project(visitor, project, %{name: "Doomed"})

      assert Projects.list_projects(visitor) == []
      assert [job] = all_enqueued(worker: ForkCleanup)
      assert [key] = job.args["object_keys"]
      assert key == "projects/#{job.args["fork_id"]}/assets/#{asset.id}-logo.png"
    end

    test "the cleanup is enqueued before any object is copied", %{
      owner: owner,
      project: project
    } do
      # Covers a copy whose process dies mid-way (closed tab, Cancel): the
      # job must already exist when the first object lands.
      s3_asset(project, owner, "a.png", 10)
      test_pid = self()

      on_progress = fn
        {:assets, _, _} -> send(test_pid, {:jobs, all_enqueued(worker: ForkCleanup)})
        _ -> :ok
      end

      {:ok, fork} =
        Projects.fork_project(user_scope_fixture(), project, %{name: "C"},
          on_progress: on_progress
        )

      assert_received {:jobs, [job]}
      assert job.args["fork_id"] == fork.id
    end

    test "an invalid name enqueues nothing", %{owner: owner, project: project} do
      s3_asset(project, owner, "a.png", 10)
      assert {:error, _} = Projects.fork_project(user_scope_fixture(), project, %{name: ""})
      refute_enqueued(worker: ForkCleanup)
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

      # The keys come from the job args, so deleting the source asset (or
      # the whole source project) meanwhile doesn't hide the orphan.
      Repo.delete!(asset)

      args = %{"fork_id" => ghost_id, "object_keys" => [ghost_key]}
      assert :ok = perform_job(ForkCleanup, args)
      assert {:error, _} = ExAws.S3.head_object(bucket(), ghost_key) |> ExAws.request()

      # A committed fork keeps its objects.
      s3_asset(project, owner, "d.png", 10)
      {:ok, fork} = Projects.fork_project(user_scope_fixture(), project, %{name: "Kept"})
      [copy] = Repo.all(from a in Assets.Asset, where: a.project_id == ^fork.id)

      assert :ok =
               perform_job(ForkCleanup, %{
                 "fork_id" => fork.id,
                 "object_keys" => [copy.object_key]
               })

      assert {:ok, _} = ExAws.S3.head_object(bucket(), copy.object_key) |> ExAws.request()
    end

    test "snoozes while the copy still holds the fork lock" do
      fork_id = Ecto.UUID.generate()
      test_pid = self()

      # A copy in flight: another connection holds the fork's lock.
      holder =
        spawn_link(fn ->
          :ok = Ecto.Adapters.SQL.Sandbox.checkout(Repo)

          Repo.transaction(fn ->
            Assets.lock_fork!(fork_id)
            send(test_pid, :locked)
            receive do: (:release -> :ok)
          end)

          Ecto.Adapters.SQL.Sandbox.checkin(Repo)
          send(test_pid, :released)
        end)

      assert_receive :locked
      args = %{"fork_id" => fork_id, "object_keys" => ["projects/#{fork_id}/assets/x"]}
      assert {:snooze, _} = perform_job(ForkCleanup, args)
      send(holder, :release)
      assert_receive :released
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

  # An asset backed by a real object in the (RustFS) bucket.
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
