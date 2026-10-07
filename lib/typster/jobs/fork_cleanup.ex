defmodule Typster.Jobs.ForkCleanup do
  @moduledoc """
  Oban job that deletes the S3 objects a cancelled or failed fork copied
  before its transaction rolled back. Skips when the fork project exists (the
  copy committed after all), so it can never touch a live project's files.
  """
  use Oban.Worker, queue: :default, max_attempts: 3

  alias Typster.Projects.Project
  alias Typster.Repo

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"fork_id" => fork_id, "source_project_id" => source_id}}) do
    if Repo.get(Project, fork_id) do
      :ok
    else
      Typster.Assets.delete_fork_objects(fork_id, source_id)
    end
  end
end
