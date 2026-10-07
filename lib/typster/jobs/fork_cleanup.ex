defmodule Typster.Jobs.ForkCleanup do
  @moduledoc """
  Safety net that deletes the S3 objects a fork copied before its
  transaction rolled back (cancelled, failed, or its process killed — e.g. a
  closed tab). `Typster.Projects.fork_project/4` enqueues it before the copy
  starts, with the exact object keys the copy may write.

  While the copy still holds the fork's advisory lock the job snoozes; once
  the fork project exists (the copy committed) it does nothing, so it can
  never touch a live project's files.
  """
  use Oban.Worker, queue: :default, max_attempts: 3

  alias Typster.Assets
  alias Typster.Projects.Project
  alias Typster.Repo

  @snooze_seconds 60

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"fork_id" => fork_id, "object_keys" => keys}}) do
    Repo.transaction(fn ->
      cond do
        not Assets.try_lock_fork(fork_id) -> Repo.rollback(:in_flight)
        Repo.get(Project, fork_id) -> :ok
        true -> Assets.delete_fork_objects(keys)
      end
    end)
    |> case do
      {:ok, result} -> result
      {:error, :in_flight} -> {:snooze, @snooze_seconds}
    end
  end
end
