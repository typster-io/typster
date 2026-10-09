defmodule Typster.Files do
  @moduledoc """
  The Files context.
  """

  import Ecto.Query, warn: false
  alias Typster.Accounts.Scope
  alias Typster.Projects.File
  alias Typster.Repo
  alias Typster.Sharing.Collaborator

  @editable_extensions ~w(.typ .bib .md .yaml .yml .tex .latex .sty .cls .csv .tsv)
  @asset_extensions ~w(.pdf .png .jpg .jpeg .svg .webp .ttf .otf .woff .woff2)

  def get_file!(%Scope{user: user}, id) do
    from(f in File,
      join: p in assoc(f, :project),
      left_join: c in Collaborator,
      on: c.project_id == p.id and c.user_id == ^user.id and c.status == :accepted,
      where: f.id == ^id and (p.user_id == ^user.id or not is_nil(c.id))
    )
    |> Repo.one!()
  end

  def get_file(%Scope{user: user}, id) do
    from(f in File,
      join: p in assoc(f, :project),
      left_join: c in Collaborator,
      on: c.project_id == p.id and c.user_id == ^user.id and c.status == :accepted,
      where: f.id == ^id and (p.user_id == ^user.id or not is_nil(c.id))
    )
    |> Repo.one()
  end

  def create_file(%Scope{} = scope, project_id, attrs \\ %{}) do
    _project = Typster.Projects.get_editable_project!(scope, project_id)

    %File{project_id: project_id}
    |> File.changeset(attrs)
    |> Repo.insert()
  end

  def update_file_content(%Scope{} = scope, %File{} = file, content) do
    file = get_file!(scope, file.id)

    file
    |> File.changeset(%{content: content})
    |> Repo.update()
  end

  def update_file(%Scope{} = scope, %File{} = file, attrs) do
    file = get_file!(scope, file.id)

    file
    |> File.changeset(attrs)
    |> Repo.update()
  end

  def delete_file(%Scope{} = scope, %File{} = file) do
    file = get_file!(scope, file.id)
    Repo.delete(file)
  end

  @doc "Pin or unpin a file (controls whether it appears in the sidebar's Pinned section)."
  def set_pinned(%Scope{} = scope, %File{} = file, pinned) when is_boolean(pinned) do
    scope
    |> get_file!(file.id)
    |> Ecto.Changeset.change(pinned: pinned)
    |> Repo.update()
  end

  def get_file_tree(%Scope{} = scope, project_id) do
    _project = Typster.Projects.get_editable_project!(scope, project_id)

    from(f in File,
      where: f.project_id == ^project_id,
      preload: [:parent],
      order_by: [asc: f.path]
    )
    |> Repo.all()
  end

  def editable_file?(%File{path: path}), do: editable_path?(path)
  def editable_file?(path) when is_binary(path), do: editable_path?(path)
  def editable_file?(_), do: false

  def asset_file?(%File{path: path}), do: asset_path?(path)
  def asset_file?(path) when is_binary(path), do: asset_path?(path)
  def asset_file?(_), do: false

  @doc """
  Read an upload's temp file, confined to the system temp dir where LiveView
  writes uploads — defense in depth against path traversal.
  """
  def read_upload!(path) do
    tmp = Path.expand(System.tmp_dir!())
    expanded = Path.expand(path)

    unless String.starts_with?(expanded, tmp <> "/") do
      raise ArgumentError, "upload path is outside the temp directory"
    end

    case :file.read_file(expanded) do
      {:ok, content} -> content
      {:error, reason} -> raise "could not read upload (#{:file.format_error(reason)})"
    end
  end

  def typst_file?(%File{path: path}), do: extension(path) == ".typ"
  def typst_file?(path) when is_binary(path), do: extension(path) == ".typ"
  def typst_file?(_), do: false

  def bibtex_file?(%File{path: path}), do: extension(path) == ".bib"
  def bibtex_file?(path) when is_binary(path), do: extension(path) == ".bib"
  def bibtex_file?(_), do: false

  def file_kind(%File{path: path}), do: file_kind(path)

  def file_kind(path) when is_binary(path) do
    cond do
      editable_path?(path) -> :text
      asset_path?(path) -> :asset
      true -> :unknown
    end
  end

  def file_kind(_), do: :unknown

  def editor_language(path) when is_binary(path) do
    case extension(path) do
      ".typ" -> "typst"
      ".bib" -> "bibtex"
      ".md" -> "markdown"
      ext when ext in ~w(.yaml .yml) -> "yaml"
      ext when ext in ~w(.tex .latex .sty .cls) -> "latex"
      _ -> "plain"
    end
  end

  def editor_language(_), do: "plain"

  # ── Smart new-file suggestions ────────────────────────────────────────────
  #
  # When the user types a name without an extension we suggest one based on the
  # project's composition rather than a fixed default:
  #
  #   * mostly LaTeX sources → `.tex`, otherwise → `.typ`
  #   * a name that reads like a known bibliography file (references/refs/
  #     bibliography/local/library) offers `.bib` **first** when the project has
  #     no bibliography yet, then the project's majority source type.

  @latex_extensions ~w(.tex .latex .sty .cls)
  @bib_basenames ~w(references refs bibliography local library)
  # Minimum typed length before a name counts as "most of" a bibliography name.
  @bib_match_min 3

  @doc """
  Extension to suggest for a new source file: `".tex"` when the project is
  LaTeX-heavy, otherwise `".typ"`. Ties favor Typst.
  """
  def majority_source_extension(files) do
    {latex, typst} =
      Enum.reduce(files, {0, 0}, fn file, {latex, typst} ->
        case extension(path_of(file)) do
          ext when ext in @latex_extensions -> {latex + 1, typst}
          ".typ" -> {latex, typst + 1}
          _ -> {latex, typst}
        end
      end)

    if latex > typst, do: ".tex", else: ".typ"
  end

  @doc "Whether the project already contains a `.bib` file."
  def has_bibliography?(files), do: Enum.any?(files, &(extension(path_of(&1)) == ".bib"))

  @doc """
  Ordered full-name suggestions for a partially typed file name.

  Returns `[]` when nothing is typed or the user already typed an extension
  (their explicit choice wins). Otherwise the first element is the default that
  pressing Enter resolves to; a bibliography-like name with no existing `.bib`
  yields two options (`.bib` then the majority source type).
  """
  def new_file_suggestions(files, typed) do
    typed = String.trim(typed || "")

    cond do
      typed == "" ->
        []

      extension(typed) != "" ->
        []

      bib_name_match?(typed) and not has_bibliography?(files) ->
        [typed <> ".bib", typed <> majority_source_extension(files)]

      true ->
        [typed <> majority_source_extension(files)]
    end
  end

  @doc """
  Resolve the final path to create from a typed name: keep an explicit
  extension, otherwise apply the first smart suggestion.
  """
  def resolve_new_file_path(files, typed) do
    typed = String.trim(typed || "")

    cond do
      typed == "" ->
        ""

      extension(typed) != "" ->
        typed

      true ->
        case new_file_suggestions(files, typed) do
          [first | _] -> first
          [] -> typed <> majority_source_extension(files)
        end
    end
  end

  defp bib_name_match?(typed) do
    stem = typed |> Path.basename() |> String.downcase()

    String.length(stem) >= @bib_match_min and
      Enum.any?(@bib_basenames, &String.starts_with?(&1, stem))
  end

  defp path_of(%File{path: path}), do: path
  defp path_of(%{path: path}), do: path
  defp path_of(path) when is_binary(path), do: path

  defp editable_path?(path), do: extension(path) in @editable_extensions
  defp asset_path?(path), do: extension(path) in @asset_extensions
  defp extension(path), do: path |> Path.extname() |> String.downcase()

  def change_file(%File{} = file, attrs \\ %{}) do
    File.changeset(file, attrs)
  end
end
