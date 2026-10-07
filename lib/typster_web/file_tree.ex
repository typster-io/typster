defmodule TypsterWeb.FileTree do
  @moduledoc """
  Builds and renders the editor sidebar's file/asset navigation in three view
  modes — `:tree` (foldable folders), `:smart` (single-file folders inlined as
  `dir/file.ext`), and `:flat` (full paths) — from a flat list of `%File{}` /
  `%Asset{}` records keyed by their `path`/`filename`.
  """
  use TypsterWeb, :html

  @doc "Short label for the current view mode (for the switcher button)."
  def view_label(:smart), do: gettext("editor.view.smart")
  def view_label(:flat), do: gettext("editor.view.flat")
  def view_label(_tree), do: gettext("editor.view.tree")

  @doc "Normalize the mode string from the client into a known atom (no String.to_atom on input)."
  def mode("smart"), do: :smart
  def mode("flat"), do: :flat
  def mode(_), do: :tree

  @doc """
  Build render nodes for the file list in the given mode. `current_path` is the
  open file's path: dragged rows insert references relative to it.
  """
  def file_nodes(files, mode, current_path \\ nil) do
    files
    |> Enum.map(fn f ->
      %{
        path: f.path,
        id: f.id,
        editable: Typster.Files.editable_file?(f),
        asset?: false,
        pinned: Map.get(f, :pinned, false),
        insert: if(f.path != current_path, do: insert_snippet(f.path, current_path))
      }
    end)
    |> by_mode(mode)
  end

  @doc """
  Build render nodes for the assets list in the given mode.

  `font_families` maps a font's reference path (`assets/Foo.ttf`) to the
  family names the preview compiler detected; a font row shows those instead
  of its size so the writer knows what to put in `#set text(font: …)`.
  """
  def asset_nodes(assets, mode, font_families \\ %{}, current_path \\ nil) do
    assets
    |> Enum.map(fn a ->
      kind = Typster.Assets.kind(a)

      %{
        path: a.filename,
        id: a.id,
        asset?: true,
        editable: false,
        kind: asset_chip_kind(kind),
        meta: asset_meta(a, kind, font_families),
        meta_title: asset_meta_title(a, kind, font_families),
        insert: asset_insert(a, kind, font_families, current_path)
      }
    end)
    |> by_mode(mode)
  end

  defp asset_chip_kind(:font), do: "font"
  defp asset_chip_kind(:web_font), do: "font"
  defp asset_chip_kind(:image), do: "img"
  defp asset_chip_kind(_), do: "file"

  defp asset_meta(a, :font, families) do
    case Map.get(families, Typster.Assets.reference_path(a), []) do
      [] -> human_size(a.size)
      names -> Enum.join(names, ", ")
    end
  end

  defp asset_meta(_a, :web_font, _families), do: gettext("editor.assets.font_unsupported")
  defp asset_meta(a, _kind, _families), do: human_size(a.size)

  defp asset_meta_title(a, :font, families) do
    case Map.get(families, Typster.Assets.reference_path(a), []) do
      [family | _] -> gettext("editor.assets.font_hint", family: family)
      [] -> nil
    end
  end

  defp asset_meta_title(_a, :web_font, _), do: gettext("editor.assets.font_unsupported_title")
  defp asset_meta_title(_a, _kind, _), do: nil

  @doc """
  The Typst snippet dropped into the editor when an asset row is dragged there,
  or `nil` when the asset has nothing to insert (an unreadable web font, or a
  font whose family the preview has not reported yet).
  """
  def asset_insert(a, kind, families \\ %{}, current_path \\ nil)

  def asset_insert(a, :font, families, _current_path) do
    case Map.get(families, Typster.Assets.reference_path(a), []) do
      [family | _] -> ~s|#set text(font: #{typst_string(family)})|
      [] -> nil
    end
  end

  def asset_insert(_a, :web_font, _families, _current_path), do: nil

  def asset_insert(a, _kind, _families, current_path),
    do: insert_snippet(Typster.Assets.reference_path(a), current_path)

  # Typst call each extension is inserted with; anything else is `#read`.
  @insert_calls %{
    ".typ" => "include",
    ".png" => "image",
    ".jpg" => "image",
    ".jpeg" => "image",
    ".gif" => "image",
    ".svg" => "image",
    ".webp" => "image",
    ".bib" => "bibliography",
    ".csv" => "csv",
    ".json" => "json",
    ".yaml" => "yaml",
    ".yml" => "yaml",
    ".toml" => "toml",
    ".xml" => "xml"
  }

  @doc """
  The Typst snippet that references the project file at `path` from the file at
  `current_path`, with the path written relative to that file's directory.
  """
  def insert_snippet(path, current_path \\ nil) do
    ref = typst_string(relative_path(path, current_path))

    case Map.get(@insert_calls, path |> Path.extname() |> String.downcase(), "read") do
      "include" -> "#include #{ref}"
      call -> "##{call}(#{ref})"
    end
  end

  defp relative_path(path, nil), do: path

  defp relative_path(path, current_path),
    do: Path.relative_to(path, Path.dirname(current_path), force: true)

  defp typst_string(text) do
    ~s|"| <> (text |> String.replace("\\", "\\\\") |> String.replace(~s|"|, ~s|\\"|)) <> ~s|"|
  end

  defp by_mode(items, :flat), do: Enum.map(items, &Map.merge(&1, %{type: :leaf, name: &1.path}))
  defp by_mode(items, :smart), do: items |> build_tree() |> smart_collapse()
  defp by_mode(items, _tree), do: build_tree(items)

  @doc false
  def build_tree(items) do
    Enum.reduce(items, [], fn item, nodes ->
      insert(nodes, String.split(item.path, "/"), item, "")
    end)
  end

  defp insert(nodes, [name], item, _prefix) do
    nodes ++ [Map.merge(item, %{type: :leaf, name: name})]
  end

  defp insert(nodes, [name | rest], item, prefix) do
    dir_path = if prefix == "", do: name, else: prefix <> "/" <> name

    case Enum.find_index(nodes, &(&1.type == :dir and &1.name == name)) do
      nil ->
        dir = %{
          type: :dir,
          name: name,
          path: dir_path,
          children: insert([], rest, item, dir_path)
        }

        nodes ++ [dir]

      idx ->
        dir = Enum.at(nodes, idx)
        List.replace_at(nodes, idx, %{dir | children: insert(dir.children, rest, item, dir_path)})
    end
  end

  # Collapse directories that hold exactly one (non-dir) child into "dir/child".
  defp smart_collapse(nodes) do
    Enum.map(nodes, fn
      %{type: :dir, children: [%{type: :leaf} = child]} = dir ->
        Map.merge(child, %{name: dir.name <> "/" <> child.name, smart: true})

      %{type: :dir, children: children} = dir ->
        %{dir | children: smart_collapse(children)}

      leaf ->
        leaf
    end)
  end

  @doc "Human-readable byte size in SI units, e.g. `248 kB`."
  def human_size(nil), do: ""
  def human_size(b) when b < 1000, do: "#{b} B"
  def human_size(b) when b < 1_000_000, do: "#{round(b / 1000)} kB"
  def human_size(b), do: "#{Float.round(b / 1_000_000, 1)} MB"

  defp expanded?(collapsed, path), do: not MapSet.member?(collapsed, path)

  defp leaf_dom_id(%{asset?: true, id: id}, prefix), do: "#{prefix}asset-entry-#{id}"
  defp leaf_dom_id(%{id: id}, prefix), do: "#{prefix}select-file-#{id}"

  @doc "Color/glyph bucket for a file's typed chip, from its extension."
  def file_chip_kind(name) do
    case name |> Path.extname() |> String.downcase() do
      ".typ" -> "typ"
      ".bib" -> "bib"
      ext when ext in ~w(.tex .latex .sty .cls) -> "tex"
      ".md" -> "md"
      ext when ext in ~w(.csv .tsv) -> "csv"
      ext when ext in ~w(.png .jpg .jpeg .gif .svg .webp) -> "img"
      ext when ext in ~w(.yaml .yml .toml .json) -> "data"
      _ -> "file"
    end
  end

  @doc "Single-character glyph shown inside a file's typed chip."
  def chip_glyph("typ"), do: "T"
  def chip_glyph("bib"), do: "B"
  def chip_glyph("tex"), do: "L"
  def chip_glyph("md"), do: "M"
  def chip_glyph("csv"), do: "≡"
  def chip_glyph("img"), do: "▢"
  def chip_glyph("font"), do: "F"
  def chip_glyph("data"), do: "{}"
  def chip_glyph(_), do: "·"

  attr :nodes, :list, required: true
  attr :depth, :integer, default: 0
  attr :collapsed, :any, required: true
  attr :current_id, :any, default: nil
  attr :id_prefix, :string, default: ""
  attr :dnd, :boolean, default: false

  @doc "Recursively render tree rows (siblings share one `<ul>`, indented by depth)."
  def tree_rows(assigns) do
    ~H"""
    <%= for node <- @nodes do %>
      <%= if node.type == :dir do %>
        <li
          class="ts-tree__item ts-tree__dir"
          style={"padding-left: #{6 + @depth * 14}px"}
          phx-click="toggle_dir"
          phx-value-path={node.path}
          data-dnd-dir={if @dnd, do: node.path}
        >
          <.icon
            name={
              if expanded?(@collapsed, node.path), do: "hero-chevron-down", else: "hero-chevron-right"
            }
            class="size-3"
          />
          <span class="ts-tree__ficon" aria-hidden="true">
            <i data-lucide={
              if expanded?(@collapsed, node.path), do: "folder-open", else: "folder-closed"
            }>
            </i>
          </span>
          <span class="truncate flex-1">{node.name}</span>
          <span class="ts-tree__count">{length(node.children)}</span>
        </li>
        <.tree_rows
          :if={expanded?(@collapsed, node.path)}
          nodes={node.children}
          depth={@depth + 1}
          collapsed={@collapsed}
          current_id={@current_id}
          id_prefix={@id_prefix}
          dnd={@dnd}
        />
      <% else %>
        <% can_drag = @dnd and not node.asset? and node.editable %>
        <li
          id={leaf_dom_id(node, @id_prefix)}
          phx-click={if not node.asset? and node.editable, do: "select_file"}
          phx-value-file-id={node.id}
          draggable={(can_drag or Map.get(node, :insert) != nil) && "true"}
          data-dnd-file={if can_drag, do: node.id}
          data-insert={Map.get(node, :insert)}
          title={Map.get(node, :insert) && gettext("editor.assets.drag_hint")}
          class={[
            "ts-tree__item",
            node.asset? && "is-asset",
            (not node.asset? and not node.editable) && "is-disabled",
            (not node.asset? and @current_id == node.id) && "is-active"
          ]}
          style={"padding-left: #{6 + @depth * 14 + 14}px"}
        >
          <% kind = if node.asset?, do: Map.get(node, :kind, "img"), else: file_chip_kind(node.name) %>
          <span class={["ts-filechip", "ts-filechip--#{kind}"]}>{chip_glyph(kind)}</span>
          <span class="truncate flex-1">{node.name}</span>
          <span :if={Map.get(node, :smart)} class="ts-tree__smart">↳</span>
          <span
            :if={Map.get(node, :meta, "") != ""}
            class={["ts-tree__pill", kind == "font" && "ts-tree__pill--font"]}
            title={Map.get(node, :meta_title)}
          >
            {node.meta}
          </span>
          <span
            :if={Map.get(node, :pinned, false)}
            class="ts-tree__pin-ind"
            title={gettext("editor.tree.pinned")}
          >
            <i data-lucide="pin" aria-hidden="true"></i>
          </span>
          <span class="ts-tree__actions">
            <button
              :if={not node.asset?}
              type="button"
              class={["ts-tree__act", Map.get(node, :pinned, false) && "is-on"]}
              phx-click="toggle_pin"
              phx-value-id={node.id}
              aria-label={
                if(Map.get(node, :pinned, false),
                  do: gettext("editor.tree.unpin"),
                  else: gettext("editor.tree.pin")
                )
              }
            >
              <i
                data-lucide={if Map.get(node, :pinned, false), do: "pin-off", else: "pin"}
                aria-hidden="true"
              >
              </i>
            </button>
            <button
              type="button"
              class="ts-tree__act ts-tree__act--danger"
              phx-click={if node.asset?, do: "delete_asset", else: "delete_file"}
              phx-value-id={node.id}
              phx-confirm={gettext("editor.tree.delete_confirm")}
              aria-label={gettext("editor.tree.delete")}
            >
              <.icon name="hero-trash" class="size-3" />
            </button>
          </span>
        </li>
      <% end %>
    <% end %>
    """
  end
end
