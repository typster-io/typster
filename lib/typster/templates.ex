defmodule Typster.Templates do
  @moduledoc """
  The Templates context: a user's own reusable starting points for new files.
  """

  import Ecto.Query, warn: false
  alias Typster.Accounts.Scope
  alias Typster.Files
  alias Typster.Repo
  alias Typster.Templates.Template

  @doc "List the current user's templates, newest first."
  def list_templates(%Scope{user: user}) do
    from(t in Template, where: t.user_id == ^user.id, order_by: [desc: t.updated_at])
    |> Repo.all()
  end

  def get_template!(%Scope{user: user}, id) do
    from(t in Template, where: t.id == ^id and t.user_id == ^user.id)
    |> Repo.one!()
  end

  @doc "Save a new template owned by the current user."
  def create_template(%Scope{user: user}, attrs) do
    %Template{user_id: user.id}
    |> Template.changeset(attrs)
    |> Repo.insert()
  end

  @doc """
  Save an uploaded file as a template. Only text sources the editor can open
  (see `Typster.Files.editable_file?/1`) with valid UTF-8 content qualify;
  anything else is `{:error, :unsupported}`.
  """
  def create_from_upload(%Scope{} = scope, name, content)
      when is_binary(name) and is_binary(content) do
    if Files.editable_file?(name) and String.valid?(content),
      do: create_template(scope, %{name: name, content: content}),
      else: {:error, :unsupported}
  end

  @doc """
  The project file a template seeds: a `.typ` template becomes `main.typ` so
  the editor opens it first; other text files keep their own name.
  """
  def seed_path(%Template{name: name}) do
    if Files.typst_file?(name), do: "main.typ", else: name
  end

  def delete_template(%Scope{} = scope, %Template{} = template) do
    template = get_template!(scope, template.id)
    Repo.delete(template)
  end
end
