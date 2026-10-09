defmodule TypsterWeb.ProjectLive.Index do
  use TypsterWeb, :live_view

  alias Typster.Files
  alias Typster.Projects
  alias Typster.Sharing
  alias Typster.Templates

  @accent_hexes %{
    "indigo" => "#4f46e5",
    "violet" => "#7c3aed",
    "sky" => "#0ea5e9",
    "emerald" => "#10b981",
    "rose" => "#e11d48"
  }

  @impl true
  def mount(_params, _session, socket) do
    # Claim any invites addressed to this user's email (and heal mis-linked
    # ones) so projects shared with them show up here. Connected mount only, to
    # keep the write off the dead render — the connected mount re-fetches below.
    if connected?(socket), do: Sharing.link_invites_for_user(socket.assigns.current_scope)

    {:ok,
     socket
     |> assign(:page_title, gettext("projects.index.title"))
     |> assign(:search, "")
     |> assign(:filter, "all")
     |> assign(:show_new_dialog, false)
     |> assign(:file_counts, Projects.file_counts(socket.assigns.current_scope))
     |> assign(:templates, Templates.list_templates(socket.assigns.current_scope))
     |> allow_upload(:template,
       accept: :any,
       max_entries: 1,
       max_file_size: 2_000_000,
       auto_upload: true,
       progress: &handle_template_progress/3
     )
     |> load_projects()}
  end

  @impl true
  def handle_params(_params, _url, socket) do
    {:noreply, socket}
  end

  @impl true
  def handle_event("delete", %{"id" => id}, socket) do
    # Owner-only and crash-proof: collaborators don't get a delete button, but a
    # crafted event must still no-op rather than raise on the ownership check.
    case Projects.get_project(socket.assigns.current_scope, id) do
      nil ->
        {:noreply, socket}

      project ->
        {:ok, _} = Projects.delete_project(socket.assigns.current_scope, project)

        {:noreply,
         socket
         |> assign(:project_count, max(socket.assigns.project_count - 1, 0))
         |> stream_delete(:projects, project)}
    end
  end

  @impl true
  def handle_event("new_project", _params, socket) do
    {:noreply, assign(socket, :show_new_dialog, true)}
  end

  @impl true
  def handle_event("close_dialog", _params, socket) do
    {:noreply, assign(socket, :show_new_dialog, false)}
  end

  @impl true
  def handle_event("create_project", %{"name" => name} = params, socket) do
    scope = socket.assigns.current_scope
    name = String.trim(name)

    case Projects.create_project(scope, %{name: name}) do
      {:ok, project} ->
        seed_from_template(scope, project, Map.get(params, "template", ""))

        {:noreply,
         socket
         |> assign(:show_new_dialog, false)
         |> assign(:file_counts, Projects.file_counts(scope))
         |> load_projects()}

      {:error, _changeset} ->
        {:noreply, socket}
    end
  end

  @impl true
  def handle_event("validate_template", _params, socket), do: {:noreply, socket}

  @impl true
  def handle_event("delete_template", %{"id" => id}, socket) do
    scope = socket.assigns.current_scope
    template = Templates.get_template!(scope, id)
    {:ok, _} = Templates.delete_template(scope, template)
    {:noreply, assign(socket, :templates, Templates.list_templates(scope))}
  end

  @impl true
  def handle_event("search", %{"value" => query}, socket) do
    {:noreply, socket |> assign(:search, query) |> load_projects()}
  end

  @impl true
  def handle_event("filter", %{"filter" => filter}, socket) do
    {:noreply, socket |> assign(:filter, filter) |> load_projects()}
  end

  # A new project starts from the chosen template's content, as `main.typ` for
  # a `.typ` template so the editor opens it first. "" means a blank project.
  defp seed_from_template(_scope, _project, ""), do: :blank

  defp seed_from_template(scope, project, template_id) do
    template = Templates.get_template!(scope, template_id)

    {:ok, _file} =
      Files.create_file(scope, project.id, %{
        path: Templates.seed_path(template),
        content: template.content || ""
      })

    :seeded
  end

  # The dropzone takes one text source at a time and saves it straight away;
  # binaries and unknown extensions are refused with a flash.
  defp handle_template_progress(:template, %{done?: true} = entry, socket) do
    scope = socket.assigns.current_scope

    result =
      consume_uploaded_entry(socket, entry, fn %{path: path} ->
        {:ok, Templates.create_from_upload(scope, entry.client_name, Files.read_upload!(path))}
      end)

    socket = assign(socket, :templates, Templates.list_templates(scope))

    case result do
      {:ok, _template} ->
        {:noreply, put_flash(socket, :info, gettext("projects.flash.template_saved"))}

      {:error, _reason} ->
        {:noreply, put_flash(socket, :error, gettext("projects.flash.template_unsupported"))}
    end
  end

  defp handle_template_progress(:template, _entry, socket), do: {:noreply, socket}

  # Refetches projects for the current filter + search and re-streams them.
  defp load_projects(socket) do
    projects = listed_projects(socket.assigns.current_scope, socket.assigns.filter)

    filtered =
      case String.trim(socket.assigns.search) do
        "" ->
          projects

        query ->
          q = String.downcase(query)
          Enum.filter(projects, &String.contains?(String.downcase(&1.name), q))
      end

    socket
    |> assign(:project_count, length(filtered))
    |> stream(:projects, filtered, reset: true)
  end

  # "all" keeps newest-first; "recent" sorts by last update. Starred/Archive
  # have no backing columns yet, so they intentionally resolve to an empty set.
  defp listed_projects(scope, "recent") do
    scope |> Projects.list_projects() |> Enum.sort_by(& &1.updated_at, {:desc, DateTime})
  end

  defp listed_projects(_scope, filter) when filter in ["starred", "archive"], do: []
  defp listed_projects(scope, _all), do: Projects.list_projects(scope)

  defp file_count(counts, project_id), do: Map.get(counts, project_id, 0)

  # The current user owns this project (vs. reaching it as a collaborator).
  # Drives the "Shared" badge and gates owner-only actions like delete.
  defp owned?(scope, project), do: project.user_id == scope.user.id

  # Deterministic accent hue per project name, so initials stay stable.
  defp project_hue(name) do
    keys = Map.keys(@accent_hexes) |> Enum.sort()
    index = :erlang.phash2(name, length(keys))
    Map.fetch!(@accent_hexes, Enum.at(keys, index))
  end

  defp project_initial(name) do
    name |> String.trim() |> String.first() |> Kernel.||("·") |> String.upcase()
  end

  defp relative_time(%DateTime{} = dt) do
    diff = DateTime.diff(DateTime.utc_now(), dt, :second)

    cond do
      diff < 60 -> gettext("time.just_now")
      diff < 3600 -> ngettext("1 minute ago", "%{count} minutes ago", div(diff, 60))
      diff < 86_400 -> ngettext("1 hour ago", "%{count} hours ago", div(diff, 3600))
      diff < 604_800 -> ngettext("1 day ago", "%{count} days ago", div(diff, 86_400))
      true -> Calendar.strftime(dt, "%b %d, %Y")
    end
  end
end
