defmodule TypsterWeb.EditorLive.Index do
  use TypsterWeb, :live_view

  alias Typster.Assets
  alias Typster.Features
  alias Typster.Files
  alias Typster.Projects
  alias Typster.Revisions
  alias Typster.Sharing
  alias Typster.Templates

  # Stable avatar colours for the share People list (hashed from the email).
  @collab_palette ~w(#6366f1 #8b5cf6 #0ea5e9 #10b981 #f43f5e #f59e0b)

  @impl true
  def mount(%{"id" => project_id}, _session, socket) do
    scope = socket.assigns.current_scope

    # Non-bang lookup: strangers hitting a project URL they can't edit get a
    # friendly redirect, not a 500. One generic message for "doesn't exist"
    # and "no access" — the response must not leak which one it was.
    case Projects.get_editable_project(scope, project_id) do
      nil ->
        {:ok,
         socket
         |> put_flash(:error, gettext("editor.project_unavailable"))
         |> push_navigate(to: ~p"/projects")}

      project ->
        mount_project(socket, scope, project)
    end
  end

  defp mount_project(socket, scope, project) do
    project_id = project.id
    file_tree = Files.get_file_tree(scope, project_id)
    assets = Assets.list_assets(scope, project_id)
    main_file = initial_file(file_tree)

    if connected?(socket) and scope.user do
      TypsterWeb.Presence.track_user(self(), project.id, scope.user)
      Phoenix.PubSub.subscribe(Typster.PubSub, TypsterWeb.Presence.topic(project.id))
    end

    {:ok,
     socket
     |> assign(:project, project)
     |> assign(:owner?, Projects.owner?(scope, project))
     # Real-time Yjs co-editing — off by default until the editor content
     # binding is finished. Enable per-env with `config :typster, collab_enabled: true`.
     |> assign(:collab?, Application.get_env(:typster, :collab_enabled, false))
     |> assign(:collaborators, present_collaborators(scope, project.id))
     |> assign(:file_tree, file_tree)
     |> assign(:assets, assets)
     |> assign(:current_file, main_file)
     |> assign(:active_dir, file_dir(main_file))
     |> assign(:create_dir, "")
     |> assign(:open_file_ids, if(main_file, do: [main_file.id], else: []))
     |> assign(:content, if(main_file, do: main_file.content || "", else: ""))
     |> assign(:editor_language, editor_language(main_file))
     |> assign(:project_sources, project_sources(file_tree))
     |> assign(:project_assets, project_assets(assets))
     |> assign(:save_status, "saved")
     |> assign(:preview_stats, nil)
     |> assign(:preview_error, nil)
     |> assign(:preview_error_count, 0)
     |> assign(:preview_compiling, false)
     |> assign(:compile_history, [])
     |> assign(:diagnostics, [])
     |> assign(:compile_log, [])
     |> assign(:drawer_open, false)
     |> assign(:drawer_tab, "log")
     |> assign(:creating?, false)
     |> assign(:new_kind, :file)
     |> assign(:new_file_name, "")
     |> assign(:new_file_suggestions, [])
     |> assign(:template_content, nil)
     |> assign(:templates, Templates.list_templates(scope))
     |> assign(:file_view_mode, :tree)
     |> assign(:collapsed_dirs, MapSet.new())
     |> assign(:show_palette, false)
     |> assign(:palette_query, "")
     |> assign(:show_share, false)
     |> assign(:share_tab, "link")
     |> assign(:share_link, nil)
     |> assign(:share_analytics, nil)
     |> assign(:share_write_preview, false)
     |> assign(:embed_cfg, default_embed_cfg())
     |> assign(:embed_lang, "iframe")
     |> assign(:share_collaborators, [])
     |> assign(:invite_form, to_form(%{"email" => "", "role" => "editor"}, as: :invite))
     |> stream(:outline, [])
     |> assign(:outline_items, [])
     |> assign(:outline_count, 0)
     |> assign(:page_title, project.name)
     |> allow_upload(:asset,
       accept: ~w(.pdf .png .jpg .jpeg .svg .webp .ttf .otf .woff .woff2),
       max_entries: 5,
       max_file_size: 20_000_000
     )
     |> allow_upload(:template,
       accept: :any,
       max_entries: 1,
       max_file_size: 2_000_000,
       auto_upload: true,
       progress: &handle_template_progress/3
     )
     |> allow_upload(:dropped,
       accept: :any,
       max_entries: 10,
       max_file_size: 20_000_000,
       auto_upload: true,
       progress: &handle_dropped_progress/3
     )}
  end

  @impl true
  def handle_params(_params, _url, socket) do
    {:noreply, assign(socket, :page_title, socket.assigns.project.name)}
  end

  @impl true
  def handle_info(%Phoenix.Socket.Broadcast{event: "presence_diff"}, socket) do
    scope = socket.assigns.current_scope

    {:noreply,
     assign(socket, :collaborators, present_collaborators(scope, socket.assigns.project.id))}
  end

  # Ignore stray process messages (e.g. the Swoosh test adapter's {:email, _}
  # delivered to this process when an invite is sent) so they never crash the LV.
  def handle_info(_msg, socket), do: {:noreply, socket}

  @impl true
  def handle_event("save_started", _params, socket) do
    {:noreply, assign(socket, :save_status, "saving")}
  end

  @impl true
  def handle_event("autosave", %{"file_id" => file_id, "content" => content}, socket) do
    scope = socket.assigns.current_scope
    file = Files.get_file!(scope, file_id)

    if socket.assigns.current_file && socket.assigns.current_file.id == file.id do
      case Files.update_file_content(scope, file, content) do
        {:ok, updated_file} ->
          Revisions.create_revision(scope, file_id, content)
          file_tree = Files.get_file_tree(scope, socket.assigns.project.id)

          {:noreply,
           socket
           |> assign(:current_file, updated_file)
           |> assign(:file_tree, file_tree)
           |> assign(:project_sources, project_sources(file_tree))
           |> assign(:content, content)
           |> assign(:save_status, "saved")}

        {:error, _changeset} ->
          {:noreply, assign(socket, :save_status, "error")}
      end
    else
      {:noreply, assign(socket, :save_status, "error")}
    end
  end

  @impl true
  def handle_event("compile_started", _params, socket) do
    {:noreply, assign(socket, preview_compiling: true, preview_error: nil)}
  end

  @impl true
  def handle_event("update_preview", params, socket) do
    pages = params["pages"] || 1
    sources = length(socket.assigns.project_sources)

    log =
      log_entry(:ok, "compiled · #{params["ms"]}ms · #{pages} page(s) · #{sources} sources")

    {:noreply,
     socket
     |> assign(:preview_stats, %{ms: params["ms"], pages: pages})
     |> assign(:preview_compiling, false)
     |> assign(:preview_error, nil)
     |> assign(:preview_error_count, 0)
     |> assign(:diagnostics, [])
     |> push_compile(%{ms: params["ms"], status: :ok})
     |> push_log(log)}
  end

  @impl true
  def handle_event("preview_error", %{"message" => message} = params, socket) do
    diagnostics = normalize_diagnostics(params["diagnostics"])
    errors = params["errors"] || length(diagnostics)
    warnings = params["warnings"] || 0

    {:noreply,
     socket
     |> assign(:preview_error, message)
     |> assign(:preview_error_count, errors)
     |> assign(:preview_compiling, false)
     |> assign(:diagnostics, diagnostics)
     |> push_compile(%{ms: nil, status: if(errors > 0, do: :error, else: :warn)})
     |> push_log(log_entry(:error, error_log_text(errors, warnings)))}
  end

  @impl true
  def handle_event("toggle_drawer", _params, socket) do
    {:noreply, assign(socket, :drawer_open, not socket.assigns.drawer_open)}
  end

  @impl true
  def handle_event("set_drawer_tab", %{"tab" => tab}, socket) do
    tab = if tab == "problems", do: "problems", else: "log"
    {:noreply, assign(socket, drawer_open: true, drawer_tab: tab)}
  end

  @impl true
  def handle_event("clear_log", _params, socket) do
    {:noreply, assign(socket, :compile_log, [])}
  end

  @impl true
  def handle_event("outline_parsed", %{"items" => items}, socket) do
    {outline, _counters} =
      items
      |> Enum.with_index()
      |> Enum.map_reduce(%{}, fn {item, idx}, counters ->
        level = item["level"] || 1
        {num, counters} = section_number(level, counters)

        node = %{
          id: "outline-#{idx}",
          level: level,
          num: num,
          text: item["text"] || "",
          line: item["line"] || 1
        }

        {node, counters}
      end)

    {:noreply,
     socket
     |> assign(:outline_count, length(outline))
     # Plain copy of the stream: the ⌘K palette needs an enumerable to filter
     # headings (streams aren't), and a document's outline is small.
     |> assign(:outline_items, outline)
     |> stream(:outline, outline, reset: true)}
  end

  @impl true
  def handle_event("open_palette", _params, socket) do
    {:noreply, assign(socket, show_palette: true, palette_query: "")}
  end

  @impl true
  def handle_event("close_palette", _params, socket) do
    {:noreply, assign(socket, :show_palette, false)}
  end

  @impl true
  def handle_event("filter_palette", %{"value" => query}, socket) do
    {:noreply, assign(socket, :palette_query, query)}
  end

  @impl true
  def handle_event("open_share", _params, %{assigns: %{owner?: true}} = socket) do
    {:noreply,
     socket
     |> load_share()
     |> assign(:share_write_preview, false)
     |> assign(:embed_cfg, default_embed_cfg())
     |> assign(:embed_lang, "iframe")
     |> assign(:show_share, true)}
  end

  # Sharing is managed by the owner only; collaborators can edit but not invite.
  def handle_event("open_share", _params, socket), do: {:noreply, socket}

  # Owner-only guard for every share mutation. The UI already disables these for
  # collaborators, but this makes the backend authoritative: a crafted event from
  # a non-owner no-ops here instead of reaching `Sharing.*` (which would raise on
  # the owner-only `Projects.get_project!`). Must precede the specific handlers.
  def handle_event(event, _params, %{assigns: %{owner?: false}} = socket)
      when event in ~w(share_scope share_rotate share_toggle_download share_toggle_fork share_toggle_open_edit share_invite share_remove_collab) do
    {:noreply, socket}
  end

  @impl true
  def handle_event("close_share", _params, socket) do
    {:noreply, assign(socket, :show_share, false)}
  end

  @impl true
  def handle_event("share_tab", %{"tab" => tab}, socket)
      when tab in ~w(people link embed export) do
    {:noreply, assign(socket, :share_tab, tab)}
  end

  @impl true
  def handle_event("share_scope", %{"scope" => scope}, socket)
      when scope in ~w(read output full) do
    {:noreply,
     socket
     |> assign(:share_write_preview, false)
     |> update_share_link(%{scope: scope})}
  end

  # Pro "per-file write scope". The card is clickable so visitors can preview the
  # capability, but on Free it only reveals the upsell — it never changes the
  # link's real scope (which stays read/output/full). Pro swaps in the file picker.
  def handle_event("share_scope", %{"scope" => "write"}, socket) do
    {:noreply, assign(socket, :share_write_preview, true)}
  end

  def handle_event("share_scope", _params, socket), do: {:noreply, socket}

  @impl true
  def handle_event("share_rotate", _params, socket) do
    scope = socket.assigns.current_scope

    socket =
      with link when not is_nil(link) <- socket.assigns.share_link,
           {:ok, rotated} <- Sharing.rotate_link(scope, link) do
        assign(socket, :share_link, rotated)
      else
        _ -> socket
      end

    {:noreply, socket}
  end

  @impl true
  def handle_event("share_toggle_download", _params, socket) do
    case socket.assigns.share_link do
      nil -> {:noreply, socket}
      link -> {:noreply, update_share_link(socket, %{allow_download: !link.allow_download})}
    end
  end

  @impl true
  def handle_event("share_toggle_fork", _params, socket) do
    case socket.assigns.share_link do
      nil -> {:noreply, socket}
      link -> {:noreply, update_share_link(socket, %{allow_fork: !link.allow_fork})}
    end
  end

  # The flag can be flipped by any owner, but it only has effect when the
  # owner's plan carries :share_open_collaboration (the join path re-checks via
  # Typster.Sharing.Collaboration) — so Free owners just see the locked row.
  @impl true
  def handle_event("share_toggle_open_edit", _params, socket) do
    with link when not is_nil(link) <- socket.assigns.share_link,
         true <- Features.can?(socket.assigns.current_scope, :share_open_collaboration) do
      {:noreply, update_share_link(socket, %{open_edit: !link.open_edit})}
    else
      _ -> {:noreply, socket}
    end
  end

  # ── Embed tab configurator ──────────────────────────────────────────────────
  # Toggle a boolean component chip. `editable`/`unbranded` are Pro-only; clicks
  # are ignored on Free (the chip renders locked with a PRO badge).
  @impl true
  def handle_event("embed_toggle", %{"key" => key}, socket)
      when key in ~w(tree preview editable unbranded) do
    pro? = Features.pro?(socket.assigns.current_scope)
    locked? = key in ~w(editable unbranded) and not pro?

    cfg =
      if locked? do
        socket.assigns.embed_cfg
      else
        Map.update!(socket.assigns.embed_cfg, String.to_existing_atom(key), &(!&1))
      end

    {:noreply, assign(socket, :embed_cfg, cfg)}
  end

  # Pick a value in a segmented control (Save CTA / Theme / Width). The `on-edit`
  # Save-CTA mode is Pro-only.
  def handle_event("embed_set", %{"key" => key, "val" => val}, socket)
      when key in ~w(cta theme width) do
    pro? = Features.pro?(socket.assigns.current_scope)
    locked? = key == "cta" and val == "on-edit" and not pro?

    cfg =
      if locked?,
        do: socket.assigns.embed_cfg,
        else: Map.put(socket.assigns.embed_cfg, String.to_existing_atom(key), val)

    {:noreply, assign(socket, :embed_cfg, cfg)}
  end

  def handle_event("embed_lang", %{"lang" => lang}, socket) when lang in ~w(iframe react npm) do
    {:noreply, assign(socket, :embed_lang, lang)}
  end

  @impl true
  def handle_event("share_invite", %{"invite" => %{"email" => email, "role" => role}}, socket) do
    scope = socket.assigns.current_scope
    project = socket.assigns.project

    case Sharing.invite_collaborator(scope, project.id, email, invite_role(role)) do
      {:ok, _collaborator} ->
        {:noreply,
         socket
         |> assign(:share_collaborators, Sharing.list_collaborators(scope, project.id))
         |> assign(:invite_form, to_form(%{"email" => "", "role" => "editor"}, as: :invite))
         |> put_flash(:info, gettext("share.flash.invited", email: email))}

      {:error, _changeset} ->
        {:noreply, put_flash(socket, :error, gettext("share.flash.invite_failed"))}
    end
  end

  @impl true
  def handle_event("share_remove_collab", %{"id" => id}, socket) do
    scope = socket.assigns.current_scope
    project = socket.assigns.project

    socket =
      with collab when not is_nil(collab) <-
             Enum.find(socket.assigns.share_collaborators, &(&1.id == id)),
           {:ok, _} <- Sharing.remove_collaborator(scope, collab) do
        assign(socket, :share_collaborators, Sharing.list_collaborators(scope, project.id))
      else
        _ -> socket
      end

    {:noreply, socket}
  end

  @impl true
  def handle_event("select_file", %{"file-id" => file_id}, socket) do
    scope = socket.assigns.current_scope
    file = Files.get_file!(scope, file_id)

    if Files.editable_file?(file) do
      {:noreply,
       socket
       |> open_tab(file_id)
       |> assign(:current_file, file)
       |> assign(:active_dir, file_dir(file))
       |> assign(:content, file.content || "")
       |> assign(:editor_language, editor_language(file))
       |> assign(:save_status, "saved")
       |> push_event("file_changed", %{
         file_id: file_id,
         path: file.path,
         content: file.content || "",
         language: editor_language(file)
       })
       |> push_event("content_updated", %{content: file.content || ""})}
    else
      {:noreply, put_flash(socket, :error, gettext("editor.flash.binary_asset"))}
    end
  end

  @impl true
  def handle_event("close_tab", %{"id" => file_id}, socket) do
    remaining = Enum.reject(socket.assigns.open_file_ids, &(&1 == file_id))
    socket = assign(socket, :open_file_ids, remaining)
    current = socket.assigns.current_file

    if current && current.id == file_id do
      # Activate the nearest remaining tab, or clear the editor when none remain.
      case remaining |> List.last() |> next_open_file(socket) do
        nil ->
          {:noreply,
           socket
           |> assign(:current_file, nil)
           |> assign(:content, "")
           |> assign(:editor_language, "plain")
           |> push_event("file_changed", %{file_id: nil, content: "", language: "plain"})
           |> push_event("content_updated", %{content: ""})}

        file ->
          {:noreply,
           socket
           |> assign(:current_file, file)
           |> assign(:content, file.content || "")
           |> assign(:editor_language, editor_language(file))
           |> push_event("file_changed", %{
             file_id: file.id,
             path: file.path,
             content: file.content || "",
             language: editor_language(file)
           })
           |> push_event("content_updated", %{content: file.content || ""})}
      end
    else
      {:noreply, socket}
    end
  end

  @impl true
  def handle_event("set_file_view", %{"mode" => mode}, socket) do
    {:noreply, assign(socket, :file_view_mode, TypsterWeb.FileTree.mode(mode))}
  end

  @impl true
  def handle_event("toggle_dir", %{"path" => path}, socket) do
    collapsed = socket.assigns.collapsed_dirs

    collapsed =
      if MapSet.member?(collapsed, path),
        do: MapSet.delete(collapsed, path),
        else: MapSet.put(collapsed, path)

    # Clicking a folder makes it the active directory for new files/folders.
    {:noreply, socket |> assign(:collapsed_dirs, collapsed) |> assign(:active_dir, path)}
  end

  @impl true
  def handle_event("new_file", _params, socket) do
    {:noreply, start_create(socket, :file)}
  end

  @impl true
  def handle_event("new_folder", _params, socket) do
    {:noreply, start_create(socket, :folder)}
  end

  @impl true
  def handle_event("cancel_new_file", _params, socket) do
    {:noreply,
     socket
     |> assign(creating?: false, new_file_name: "", new_file_suggestions: [])
     |> assign(:new_kind, :file)
     |> assign(:template_content, nil)}
  end

  @impl true
  def handle_event("validate_template", _params, socket), do: {:noreply, socket}

  @impl true
  def handle_event("validate_dropped", _params, socket), do: {:noreply, socket}

  @impl true
  def handle_event("use_template", %{"id" => id}, socket) do
    template = Templates.get_template!(socket.assigns.current_scope, id)
    stem = Path.rootname(template.name)

    {:noreply,
     socket
     |> assign(:creating?, true)
     |> assign(:new_kind, :file)
     |> assign(:create_dir, socket.assigns.active_dir)
     |> assign(:new_file_name, stem)
     |> assign(
       :new_file_suggestions,
       Files.new_file_suggestions(socket.assigns.file_tree, stem)
     )
     |> assign(:template_content, template.content || "")}
  end

  @impl true
  def handle_event("delete_template", %{"id" => id}, socket) do
    scope = socket.assigns.current_scope
    template = Templates.get_template!(scope, id)
    {:ok, _} = Templates.delete_template(scope, template)
    {:noreply, assign(socket, :templates, Templates.list_templates(scope))}
  end

  @impl true
  def handle_event("create_folder_from_dialog", %{"path" => typed}, socket) do
    name = typed |> String.trim() |> String.trim("/")
    folder = socket.assigns.create_dir |> join_dir(name) |> String.trim("/")

    cond do
      name == "" ->
        {:noreply, socket}

      folder_taken?(socket.assigns.file_tree, folder) ->
        {:noreply,
         socket
         |> assign(:new_file_name, typed)
         |> put_flash(:error, gettext("editor.flash.file_exists"))}

      true ->
        # Folders are path-derived, so a new folder is seeded with a starter file
        # using the project's majority source type.
        ext = Files.majority_source_extension(socket.assigns.file_tree)
        path = "#{folder}/untitled#{ext}"

        socket
        |> assign(creating?: false, new_kind: :file, new_file_name: "", new_file_suggestions: [])
        |> create_text_file(path, default_file_content(path, socket.assigns.file_tree))
    end
  end

  @impl true
  def handle_event("suggest_new_file", %{"path" => name}, socket) do
    suggestions = Files.new_file_suggestions(socket.assigns.file_tree, name)

    {:noreply,
     socket
     |> assign(:new_file_name, name)
     |> assign(:new_file_suggestions, suggestions)}
  end

  @impl true
  def handle_event("create_file_from_dialog", %{"path" => typed}, socket) do
    name = String.trim(typed)
    full = join_dir(socket.assigns.create_dir, name)
    path = Files.resolve_new_file_path(socket.assigns.file_tree, full)

    cond do
      name == "" ->
        {:noreply, socket}

      not Files.editable_file?(path) ->
        {:noreply, put_flash(socket, :error, gettext("editor.flash.unsupported_file"))}

      path_taken?(socket.assigns.file_tree, path) ->
        # Keep the draft open with the typed name (folder prefix shown separately).
        {:noreply,
         socket
         |> assign(:new_file_name, name)
         |> assign(
           :new_file_suggestions,
           Files.new_file_suggestions(socket.assigns.file_tree, name)
         )
         |> put_flash(:error, gettext("editor.flash.file_exists"))}

      true ->
        content =
          socket.assigns.template_content || default_file_content(path, socket.assigns.file_tree)

        create_text_file(assign(socket, :template_content, nil), path, content)
    end
  end

  @impl true
  def handle_event("create_file", %{"path" => path, "content" => content}, socket) do
    if Files.editable_file?(path) do
      create_text_file(socket, path, content)
    else
      {:noreply, put_flash(socket, :error, gettext("editor.flash.unsupported_file"))}
    end
  end

  @impl true
  def handle_event("toggle_pin", %{"id" => file_id}, socket) do
    scope = socket.assigns.current_scope
    file = Files.get_file!(scope, file_id)
    {:ok, _} = Files.set_pinned(scope, file, not file.pinned)
    file_tree = Files.get_file_tree(scope, socket.assigns.project.id)

    {:noreply,
     socket
     |> assign(:file_tree, file_tree)
     |> assign(:project_sources, project_sources(file_tree))}
  end

  @impl true
  def handle_event("move_file", %{"id" => file_id, "dir" => dir}, socket) do
    scope = socket.assigns.current_scope
    file = Files.get_file!(scope, file_id)
    new_path = moved_path(file.path, dir)

    if new_path == file.path do
      {:noreply, socket}
    else
      {:noreply, do_move(socket, scope, file, new_path)}
    end
  end

  @impl true
  def handle_event("delete_file", %{"id" => file_id}, socket) do
    scope = socket.assigns.current_scope
    file = Files.get_file!(scope, file_id)
    {:ok, _} = Files.delete_file(scope, file)
    file_tree = Files.get_file_tree(scope, socket.assigns.project.id)

    open_ids = Enum.reject(socket.assigns.open_file_ids, &(&1 == file.id))
    current = socket.assigns.current_file
    was_open? = current && current.id == file.id

    next_file =
      cond do
        not was_open? -> current
        open_ids != [] -> Enum.find(file_tree, &(&1.id == List.last(open_ids)))
        true -> initial_file(file_tree)
      end

    socket =
      socket
      |> assign(:file_tree, file_tree)
      |> assign(:open_file_ids, open_ids)
      |> assign(:project_sources, project_sources(file_tree))
      |> assign(:current_file, next_file)
      |> put_flash(:info, gettext("editor.flash.file_deleted"))

    if was_open? do
      content = if next_file, do: next_file.content || "", else: ""

      {:noreply,
       socket
       |> assign(:content, content)
       |> assign(:editor_language, editor_language(next_file))
       |> push_event("file_changed", file_changed_event(next_file, content))
       |> push_event("content_updated", %{content: content})}
    else
      {:noreply, socket}
    end
  end

  @impl true
  def handle_event("delete_asset", %{"id" => asset_id}, socket) do
    scope = socket.assigns.current_scope
    asset = Assets.get_asset!(scope, asset_id)
    {:ok, _} = Assets.delete_asset(scope, asset)
    assets = Assets.list_assets(scope, socket.assigns.project.id)

    {:noreply,
     socket
     |> assign(:assets, assets)
     |> assign(:project_assets, project_assets(assets))
     |> put_flash(:info, gettext("editor.flash.asset_deleted"))}
  end

  @impl true
  def handle_event("validate_upload", _params, socket) do
    {:noreply, socket}
  end

  @impl true
  def handle_event("save_upload", _params, socket) do
    scope = socket.assigns.current_scope
    project_id = socket.assigns.project.id

    results =
      consume_uploaded_entries(socket, :asset, fn %{path: path}, entry ->
        Assets.upload_entry(scope, project_id, %{
          path: path,
          client_name: entry.client_name,
          client_type: entry.client_type
        })
      end)

    case Enum.find(results, &match?({:error, _}, &1)) do
      nil ->
        assets = Assets.list_assets(scope, project_id)

        {:noreply,
         socket
         |> assign(:assets, assets)
         |> assign(:project_assets, project_assets(assets))
         |> put_flash(:info, gettext("editor.flash.asset_uploaded"))}

      {:error, _reason} ->
        {:noreply, put_flash(socket, :error, gettext("editor.flash.asset_upload_failed"))}
    end
  end

  defp create_text_file(socket, path, content) do
    scope = socket.assigns.current_scope

    case Files.create_file(scope, socket.assigns.project.id, %{path: path, content: content}) do
      {:ok, file} ->
        file_tree = Files.get_file_tree(scope, socket.assigns.project.id)

        {:noreply,
         socket
         |> assign(creating?: false, new_file_name: "", new_file_suggestions: [])
         |> assign(:file_tree, file_tree)
         |> assign(:project_sources, project_sources(file_tree))
         |> open_tab(file.id)
         |> assign(:current_file, file)
         |> assign(:content, content)
         |> assign(:editor_language, editor_language(file))
         |> push_event("file_changed", %{
           file_id: file.id,
           path: file.path,
           content: content,
           language: editor_language(file)
         })
         |> push_event("content_updated", %{content: content})}

      {:error, changeset} ->
        message =
          if path_taken_error?(changeset),
            do: gettext("editor.flash.file_exists"),
            else: gettext("editor.flash.create_failed")

        {:noreply, put_flash(socket, :error, message)}
    end
  end

  defp path_taken?(file_tree, path), do: Enum.any?(file_tree, &(&1.path == path))

  defp folder_taken?(file_tree, folder),
    do: Enum.any?(file_tree, &String.starts_with?(&1.path, folder <> "/"))

  defp path_taken_error?(changeset) do
    Enum.any?(changeset.errors, fn {field, _} -> field == :path end)
  end

  # Welcome doc for the project's first Typst file only; later files open empty
  defp default_file_content(path, file_tree) do
    if Files.typst_file?(path) and not Enum.any?(file_tree, &Files.typst_file?/1) do
      gettext("editor.starter.doc")
    else
      ""
    end
  end

  # Glyph + color bucket for the live file-type chip in the inline create row.
  defp draft_chip_ext(name, suggestions) do
    cond do
      ext_label(name) != "" -> ext_label(name)
      suggestions != [] -> ext_label(hd(suggestions))
      true -> "typ"
    end
  end

  # Extension that pressing Enter will append, or `nil` when the name already
  # carries one (so the "+ .ext" hint pill stays hidden).
  defp draft_hint(name, suggestions) do
    if ext_label(String.trim(name)) == "" and suggestions != [] do
      Path.extname(hd(suggestions))
    end
  end

  defp ext_label(path),
    do: path |> Path.extname() |> String.trim_leading(".") |> String.downcase()

  defp chip_glyph(ext) do
    case ext do
      "typ" -> "T"
      "bib" -> "B"
      "md" -> "M"
      e when e in ~w(tex latex sty cls) -> "L"
      e -> e |> String.first() |> Kernel.||("·") |> String.upcase()
    end
  end

  defp initial_file(file_tree) do
    Enum.find(file_tree, &(&1.path == "main.typ")) ||
      Enum.find(file_tree, &Files.editable_file?/1)
  end

  defp editor_language(nil), do: "plain"
  defp editor_language(file), do: Files.editor_language(file.path)

  defp palette_match?(query, label) do
    query = String.trim(query || "")
    query == "" or String.contains?(String.downcase(label), String.downcase(query))
  end

  defp palette_files(file_tree, query) do
    Enum.filter(file_tree, &(Files.editable_file?(&1) and palette_match?(query, &1.path)))
  end

  defp palette_headings(outline_items, query) do
    Enum.filter(outline_items, &palette_match?(query, &1.text))
  end

  defp save_status_label("saved"), do: gettext("editor.status.saved")
  defp save_status_label("saving"), do: gettext("editor.status.saving")
  defp save_status_label("error"), do: gettext("editor.status.error")
  defp save_status_label(status), do: status

  # Auto-save a dropped/selected template file once its bytes finish uploading.
  defp handle_template_progress(:template, entry, socket) do
    if entry.done? do
      scope = socket.assigns.current_scope

      consume_uploaded_entries(socket, :template, fn %{path: path}, e ->
        {:ok,
         Templates.create_template(scope, %{name: e.client_name, content: read_upload!(path)})}
      end)

      {:noreply,
       socket
       |> assign(:templates, Templates.list_templates(scope))
       |> put_flash(:info, gettext("editor.flash.template_saved"))}
    else
      {:noreply, socket}
    end
  end

  # Route a file dropped onto the editor/assets: asset types upload as assets,
  # editable types become new files, anything else is rejected.
  defp handle_dropped_progress(:dropped, entry, socket) do
    if entry.done?, do: {:noreply, consume_dropped(socket)}, else: {:noreply, socket}
  end

  defp consume_dropped(socket) do
    scope = socket.assigns.current_scope
    project_id = socket.assigns.project.id

    results =
      consume_uploaded_entries(socket, :dropped, fn %{path: tmp}, entry ->
        name = entry.client_name

        cond do
          Files.asset_file?(name) ->
            Assets.upload_entry(scope, project_id, %{
              path: tmp,
              client_name: name,
              client_type: entry.client_type
            })

            {:ok, :asset}

          Files.editable_file?(name) ->
            Files.create_file(scope, project_id, %{path: name, content: read_upload!(tmp)})
            {:ok, :file}

          true ->
            {:ok, {:unsupported, name}}
        end
      end)

    file_tree = Files.get_file_tree(scope, project_id)
    assets = Assets.list_assets(scope, project_id)
    unsupported = Enum.any?(results, &match?({:unsupported, _}, &1))

    socket
    |> assign(:file_tree, file_tree)
    |> assign(:project_sources, project_sources(file_tree))
    |> assign(:assets, assets)
    |> assign(:project_assets, project_assets(assets))
    |> then(fn s ->
      if unsupported,
        do: put_flash(s, :error, gettext("editor.flash.unsupported_file")),
        else: put_flash(s, :info, gettext("editor.flash.dropped_added"))
    end)
  end

  # Read an upload's temp file, confined to the system temp dir where LiveView
  # writes uploads — defense in depth against path traversal. Reads the
  # validated, expanded path.
  defp read_upload!(path) do
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

  # The directory a file lives in ("" for project root), used as the target
  # folder when creating new files/folders.
  defp file_dir(nil), do: ""

  defp file_dir(%{path: path}) do
    case Path.dirname(path) do
      "." -> ""
      dir -> dir
    end
  end

  # Destination path for a file dropped onto `dir` ("" / root = project root).
  defp moved_path(path, dir) do
    base = Path.basename(path)
    if dir in [nil, "", "."], do: base, else: dir <> "/" <> base
  end

  defp do_move(socket, scope, file, new_path) do
    case Files.update_file(scope, file, %{path: new_path}) do
      {:ok, moved} -> apply_moved(socket, scope, moved)
      {:error, _changeset} -> put_flash(socket, :error, gettext("editor.flash.move_conflict"))
    end
  end

  # Refresh the tree (and the active file struct, whose path just changed).
  defp apply_moved(socket, scope, moved) do
    file_tree = Files.get_file_tree(scope, socket.assigns.project.id)
    current = socket.assigns.current_file

    socket =
      socket
      |> assign(:file_tree, file_tree)
      |> assign(:project_sources, project_sources(file_tree))
      |> put_flash(:info, gettext("editor.flash.file_moved"))

    if current && current.id == moved.id,
      do: assign(socket, :current_file, moved),
      else: socket
  end

  # Open the inline draft targeting the active folder (shown as a static prefix,
  # not editable text) and expand that folder so the result is visible.
  defp start_create(socket, kind) do
    active_dir = socket.assigns.active_dir

    socket
    |> assign(:creating?, true)
    |> assign(:new_kind, kind)
    |> assign(:create_dir, active_dir)
    |> assign(:new_file_name, "")
    |> assign(:new_file_suggestions, [])
    |> assign(:template_content, nil)
    |> assign(:collapsed_dirs, MapSet.delete(socket.assigns.collapsed_dirs, active_dir))
  end

  defp join_dir("", name), do: name
  defp join_dir(dir, name), do: "#{dir}/#{name}"

  # Top-bar breadcrumb: project name + folder path (no filename — the file lives
  # on the tab and, in v3, on the breadcrumb row under the tabs). Last is active.
  defp topbar_segments(project, current_file) do
    folders =
      case current_file do
        %{path: path} ->
          case Path.dirname(path) do
            "." -> []
            dir -> Path.split(dir)
          end

        _ ->
          []
      end

    names = [project.name | folders]
    count = length(names)
    names |> Enum.with_index(1) |> Enum.map(fn {n, i} -> %{name: n, last: i == count} end)
  end

  # The other people currently present in this project's editor (excludes self).
  defp present_collaborators(scope, project_id) do
    exclude = scope && scope.user && scope.user.id
    TypsterWeb.Presence.list_collaborators(project_id, exclude)
  end

  # Initials/display-name for the account avatar, derived from the email local
  # part (e.g. "sam.reeves@..." -> "SR" / "Sam Reeves").
  defp user_initials(%{user: %{email: email}}) when is_binary(email) do
    email
    |> email_local_parts()
    |> Enum.map(&String.first/1)
    |> Enum.reject(&is_nil/1)
    |> Enum.take(2)
    |> Enum.map_join("", &String.upcase/1)
    |> case do
      "" -> "?"
      s -> s
    end
  end

  defp user_initials(_), do: "?"

  defp user_display_name(%{user: %{email: email}}) when is_binary(email) do
    email |> email_local_parts() |> Enum.map_join(" ", &String.capitalize/1)
  end

  defp user_display_name(_), do: gettext("editor.topbar.guest")

  defp email_local_parts(email) do
    email |> String.split("@") |> List.first() |> String.split(~r/[._-]/, trim: true)
  end

  # ── Share modal helpers ─────────────────────────────────────────────────────
  defp load_share(socket) do
    scope = socket.assigns.current_scope
    project = socket.assigns.project
    link = Sharing.get_or_create_link(scope, project.id)

    socket
    |> assign(:share_link, link)
    |> assign(:share_collaborators, Sharing.list_collaborators(scope, project.id))
    |> assign(:share_analytics, share_analytics(scope, link))
  end

  # Open-count stats for the owner's link — a Pro capability. On Free (or the
  # open-core build) `Typster.Analytics` is a no-op returning zeros, so we only
  # surface the panel when the owner is entitled.
  defp share_analytics(scope, link) do
    if Features.can?(scope, :share_link_analytics), do: Typster.Analytics.summary(link.token)
  end

  # The analytics panel's markup is a Pro-only HEEx block that lives in the Pro
  # repo (`Typster.Pro.Analytics.Components`). The host invokes it at runtime and
  # passes the host-resolved summary + translated labels (the Pro component can't
  # call the host's `~p`/`gettext`). Open core has no component → renders nothing
  # (the panel is only ever shown to entitled owners anyway).
  defp pro_analytics_panel(assigns) do
    case Typster.Analytics.components() do
      nil -> ~H""
      # `apply/3` keeps this a pure runtime call — no compile-time reference to
      # the Pro component, so the open-core build stays warning-clean.
      mod -> apply(mod, :panel, [assigns])
    end
  end

  defp analytics_labels do
    %{
      title: gettext("share.analytics.label"),
      total: gettext("share.analytics.total"),
      last_7d: gettext("share.analytics.last_7d")
    }
  end

  defp update_share_link(socket, attrs) do
    scope = socket.assigns.current_scope

    with link when not is_nil(link) <- socket.assigns.share_link,
         {:ok, updated} <- Sharing.update_link(scope, link, attrs) do
      assign(socket, :share_link, updated)
    else
      _ -> socket
    end
  end

  defp invite_role("owner"), do: :owner
  defp invite_role("viewer"), do: :viewer
  defp invite_role(_), do: :editor

  # Full public share URL for the project's link (for display + copy).
  defp share_url(project, %{token: token}),
    do: url(~p"/p/#{Sharing.slug(project)}?#{[key: token]}")

  defp share_url(_project, _link), do: "#"

  # Role label + avatar colour for the People list. Accepted collaborators have a
  # user id, so they share the exact colour of their presence avatar and cursor;
  # a still-pending invite has only an email, so it falls back to an email hash.
  defp collab_initials(%{email: email}), do: email |> initials_from(2)
  defp collab_color(%{user_id: id}) when is_binary(id), do: TypsterWeb.Presence.color_for(id)
  defp collab_color(%{email: email}), do: Enum.at(@collab_palette, :erlang.phash2(email, 6))

  # The signed-in user's remote-cursor colour. Keyed on the user **id** via the
  # same function the presence avatars use, so a person's caret and avatar are
  # always the same colour — and two different users never collide (distinct
  # emails can hash to the same slot; ids don't for our small user set).
  defp current_user_color(%{user: %{id: id}}) when not is_nil(id),
    do: TypsterWeb.Presence.color_for(id)

  defp current_user_color(_), do: List.first(@collab_palette)

  defp initials_from(email, take) do
    email
    |> String.split("@")
    |> List.first()
    |> String.split(~r/[._-]+/, trim: true)
    |> Enum.map(&String.first/1)
    |> Enum.reject(&is_nil/1)
    |> Enum.take(take)
    |> Enum.map_join("", &String.upcase/1)
    |> case do
      "" -> "?"
      s -> s
    end
  end

  defp plan_label(scope) do
    if Features.pro?(scope), do: gettext("share.plan.pro"), else: gettext("share.plan.free")
  end

  defp role_label(:owner), do: gettext("share.role.owner")
  defp role_label(:viewer), do: gettext("share.role.viewer")
  defp role_label(_), do: gettext("share.role.editor")

  defp collab_status(%{status: :pending}), do: gettext("share.people.invite_sent")
  defp collab_status(%{role: role}), do: role_label(role)

  # Default embed configurator state (mirrors the v3 EmbedTab prototype).
  defp default_embed_cfg do
    %{
      tree: true,
      preview: true,
      editable: false,
      unbranded: false,
      cta: "always",
      theme: "auto",
      width: "responsive"
    }
  end

  # Build the embed URL with the configurator's options encoded as query params.
  defp embed_src(%{token: token}, entry, cfg) do
    query =
      [
        entry && "file=#{entry.path}",
        "theme=#{cfg.theme}",
        !cfg.tree && "tree=0",
        !cfg.preview && "preview=0",
        cfg.editable && "editable=1"
      ]
      |> Enum.filter(& &1)
      |> Enum.join("&")

    "#{url(~p"/embed/#{token}")}?#{query}"
  end

  defp embed_src(_link, _entry, _cfg), do: ""

  defp embed_width_value(%{width: "responsive"}), do: "100%"
  defp embed_width_value(%{width: w}), do: w

  # The copyable snippet for the active language tab. The React and npm packages
  # aren't shipped yet, so those tabs show a playful "coming soon" placeholder
  # instead of a snippet that wouldn't work.
  defp embed_snippet(_link, _entry, _cfg, lang) when lang in ~w(react npm) do
    gettext("share.embed.coming_soon")
  end

  defp embed_snippet(link, entry, cfg, _iframe) do
    """
    <iframe
      src="#{embed_src(link, entry, cfg)}"
      width="#{embed_width_value(cfg)}"
      height="540"
      loading="lazy"
      allow="clipboard-write"
    ></iframe>\
    """
  end

  # ── Share modal function components ─────────────────────────────────────────
  attr :scope, :string, required: true
  attr :tone, :string, required: true
  attr :active, :boolean, default: false
  attr :icon, :string, required: true
  attr :badge, :string, default: nil
  attr :title, :string, required: true
  attr :desc, :string, required: true

  defp perm_card(assigns) do
    ~H"""
    <div
      class={["perm-card", "tone-#{@tone}", @active && "active"]}
      phx-click="share_scope"
      phx-value-scope={@scope}
    >
      <div class="ic"><.icon name={@icon} class="size-4" /></div>
      <div class="body">
        <div class="h">{@title}<span :if={@badge} class="badge">{@badge}</span></div>
        <div class="d">{@desc}</div>
      </div>
      <div class="radio"></div>
    </div>
    """
  end

  attr :title, :string, required: true
  attr :desc, :string, default: nil
  attr :compact, :boolean, default: false

  defp upgrade_banner(assigns) do
    ~H"""
    <div class={["upgrade-banner", @compact && "compact"]}>
      <div class="ic"><.icon name="hero-sparkles" class="size-4" /></div>
      <div class="meta">
        <div class="h">{@title}</div>
        <div :if={@desc} class="d">{@desc}</div>
      </div>
      <button type="button" class="cta">{gettext("share.upgrade.cta")}</button>
    </div>
    """
  end

  attr :label, :string, required: true
  attr :sub, :string, default: nil
  attr :on, :boolean, default: false

  defp toggle_row(assigns) do
    ~H"""
    <div class={["toggle-row", @on && "on"]}>
      <div class="meta">
        <div class="h">{@label}</div>
        <div :if={@sub} class="d">{@sub}</div>
      </div>
      <div class="switch"></div>
    </div>
    """
  end

  attr :key, :string, required: true
  attr :label, :string, required: true
  attr :on, :boolean, default: false
  attr :locked, :boolean, default: false

  # A toggle chip in the embed Components group. Locked chips are Pro-gated.
  defp cfg_chip(assigns) do
    ~H"""
    <div
      class={["cfg-chip", (@on and !@locked) && "on", @locked && "locked"]}
      phx-click="embed_toggle"
      phx-value-key={@key}
    >
      <span class="check">
        <.icon :if={@locked} name="hero-lock-closed" class="size-3" />
        <.icon :if={!@locked and @on} name="hero-check-solid" class="size-3.5" />
      </span>
      {@label}<span :if={@locked} class="pro-badge">PRO</span>
    </div>
    """
  end

  attr :key, :string, required: true
  attr :value, :string, required: true
  attr :opts, :list, required: true

  # A segmented control (Save CTA / Theme / Width). Options may be Pro-locked.
  defp cfg_seg(assigns) do
    ~H"""
    <div class="cfg-seg">
      <div
        :for={o <- @opts}
        class={["opt", (@value == o.v and !o[:locked]) && "active", o[:locked] && "locked"]}
        phx-click="embed_set"
        phx-value-key={@key}
        phx-value-val={o.v}
      >
        {o.label}<span :if={o[:locked]} class="pro-badge">PRO</span>
      </div>
    </div>
    """
  end

  # Append a file id to the open-tabs list (keeping order, no duplicates).
  defp open_tab(socket, file_id) do
    ids = socket.assigns.open_file_ids
    if file_id in ids, do: socket, else: assign(socket, :open_file_ids, ids ++ [file_id])
  end

  defp next_open_file(nil, _socket), do: nil

  defp next_open_file(file_id, socket),
    do: Enum.find(socket.assigns.file_tree, &(&1.id == file_id))

  # Open files as structs, in tab order, dropping any that no longer exist.
  defp open_tabs(file_tree, open_file_ids) do
    Enum.flat_map(open_file_ids, fn id ->
      case Enum.find(file_tree, &(&1.id == id)),
        do: (
          nil -> []
          file -> [file]
        )
    end)
  end

  # Split a path into {folder_or_nil, filename} for tab/crumb labels.
  defp split_path(path) do
    case Path.dirname(path) do
      "." -> {nil, path}
      dir -> {dir, Path.basename(path)}
    end
  end

  # ── Compile log + diagnostics ─────────────────────────────────────────────
  defp normalize_diagnostics(nil), do: []

  defp normalize_diagnostics(list) when is_list(list) do
    Enum.map(list, fn d ->
      loc = d["location"] || %{}

      %{
        severity: if(d["severity"] == "warning", do: "warning", else: "error"),
        file: loc["file"],
        line: loc["line"],
        col: loc["col"],
        message: d["message"] || ""
      }
    end)
  end

  defp normalize_diagnostics(_), do: []

  defp log_entry(kind, text) do
    %{kind: kind, text: text, at: Calendar.strftime(Time.utc_now(), "%H:%M:%S")}
  end

  # Keep the most recent 40 entries so the log can't grow unbounded.
  defp push_log(socket, entry) do
    assign(socket, :compile_log, Enum.take(socket.assigns.compile_log ++ [entry], -40))
  end

  # Status-bar compile sparkline: keep the last 12 compiles (ms + status).
  defp push_compile(socket, entry) do
    assign(socket, :compile_history, Enum.take(socket.assigns.compile_history ++ [entry], -12))
  end

  # Bar height (2–12px) for one compile, scaled to the slowest successful run.
  defp spark_height(%{ms: ms}, history) when is_integer(ms) do
    max_ms =
      history |> Enum.map(& &1.ms) |> Enum.filter(&is_integer/1) |> Enum.max(fn -> 1 end)

    trunc(max(2, ms / max(max_ms, 1) * 12))
  end

  defp spark_height(_entry, _history), do: 9

  defp error_log_text(errors, warnings) do
    parts =
      [errors > 0 && ngettext("%{count} error", "%{count} errors", errors)]
      |> Enum.concat([
        warnings > 0 && ngettext("%{count} warning", "%{count} warnings", warnings)
      ])
      |> Enum.filter(& &1)

    if parts == [], do: gettext("editor.compile_failed"), else: Enum.join(parts, " · ")
  end

  defp first_error_line(diagnostics) do
    Enum.find_value(diagnostics, fn d -> d.line end)
  end

  defp pinned_files(file_tree), do: Enum.filter(file_tree, & &1.pinned)

  # Hierarchical section numbers, with the level-1 title left unnumbered and
  # numbering starting at level 2 (1, 2, 2.1, …) per the OutlineV2 design.
  defp section_number(1, _counters), do: {"", %{}}

  defp section_number(level, counters) do
    counters =
      counters
      |> Map.update(level, 1, &(&1 + 1))
      |> Map.reject(fn {l, _} -> l > level end)

    num = Enum.map_join(2..level, ".", &Map.get(counters, &1, 1))
    {num, counters}
  end

  # Build the `file_changed` payload, tolerating a nil file (e.g. the last open
  # tab was just closed) so the nil-guards stay out of the calling handler.
  defp file_changed_event(file, content) do
    %{
      file_id: file && file.id,
      path: file && file.path,
      content: content,
      language: editor_language(file)
    }
  end

  defp project_sources(file_tree) do
    file_tree
    |> Enum.filter(&Files.editable_file?/1)
    |> Enum.map(fn file ->
      %{path: file.path, content: file.content || "", language: Files.editor_language(file.path)}
    end)
  end

  defp project_assets(assets) do
    Enum.map(assets, fn asset ->
      %{
        filename: asset.filename,
        reference_path: Assets.reference_path(asset),
        content_type: asset.content_type,
        size: asset.size
      }
    end)
  end
end
