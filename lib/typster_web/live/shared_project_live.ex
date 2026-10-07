defmodule TypsterWeb.SharedProjectLive do
  @moduledoc """
  Public, read-only view of a project shared via a link (`/p/:slug?key=…`) or
  embedded (`/embed/:token`). No authentication: the link token is the
  authorization. The document is compiled client-side in the visitor's browser
  (the same WASM worker the editor uses), so nothing is rendered server-side.

  Link `scope` decides what is shown:

    * `:read` / `:full` — the entry source (read-only) plus the live preview
    * `:output`         — the compiled preview only (source hidden)
  """
  use TypsterWeb, :live_view

  alias Typster.Embed
  alias Typster.Files
  alias Typster.Sharing

  @impl true
  def mount(params, _session, socket) do
    token = params["token"] || params["key"]

    case Sharing.get_link_by_token(token) do
      nil ->
        {:ok,
         assign(socket, link: nil, project: nil, page_title: gettext("share.public.invalid"))}

      link ->
        mount_link(socket, link, params)
    end
  end

  defp mount_link(socket, link, params) do
    files = Sharing.files_for_link(link)
    entry = pick_entry(files, params["file"])
    embed? = socket.assigns.live_action == :embed
    # The owner's plan — not the visitor's — decides the embed capabilities
    # and whether `open_edit` may hand out collaborator seats. Resolve it
    # only when a policy actually needs it.
    owner_scope =
      if embed? or link.open_edit, do: Sharing.owner_scope(link), else: nil

    policy = Embed.policy(owner_scope, params)

    # Join/fork actions live on the `/p/:slug` page only: the embed renders
    # statically inside third-party iframes (no LiveView socket to push
    # events over), so it keeps its plain-anchor CTA instead.
    can_join? =
      not embed? and Typster.Sharing.Collaboration.open_edit?(owner_scope, link)

    can_fork? = not embed? and link.allow_fork

    # Count this open once per page load — on the dead render, which happens
    # exactly once for both the embed (socket-less) and the `/p` view (whose
    # connected mount we skip). No-op unless the Pro analytics code is present.
    if not connected?(socket), do: Typster.Analytics.record(link.token)

    {:ok,
     socket
     |> assign(:link, link)
     |> assign(:project, link.project)
     |> assign(:scope_kind, link.scope)
     |> assign(:embed?, embed?)
     |> assign(:embed_theme, embed_theme(params["theme"]))
     |> assign(:show_preview?, params["preview"] != "0")
     |> assign(:mobile_pane, "preview")
     |> assign(:editable?, policy.editable)
     |> assign(:unbranded?, policy.unbranded)
     |> assign(:cta_mode, policy.cta.mode)
     |> assign(:entry, entry)
     |> assign(:content, (entry && entry.content) || "")
     |> assign(:language, entry_language(entry))
     |> assign(:project_sources, project_sources(files))
     |> assign(:can_join?, can_join?)
     |> assign(:can_fork?, can_fork?)
     |> assign(:fork_open?, reopen_fork?(socket, can_fork?, params))
     |> assign(:fork_error, nil)
     |> assign(:fork_failed?, false)
     |> assign(:fork_busy, nil)
     |> assign(:fork_stats, if(can_fork?, do: Sharing.fork_stats(link)))
     |> assign(:notice, nil)
     |> assign(:fork_form, to_form(%{"name" => copy_name(link.project.name)}, as: :fork))
     |> assign(:page_title, link.project.name)}
  end

  # The embed honors `?theme=light|dark` (anything else inherits the host theme).
  defp embed_theme(theme) when theme in ~w(light dark), do: theme
  defp embed_theme(_), do: nil

  # `?file=path` selects which file the embed opens to; otherwise auto-pick.
  defp pick_entry(files, nil), do: entry_file(files)

  defp pick_entry(files, path) do
    Enum.find(files, &(&1.path == path)) || entry_file(files)
  end

  @impl true
  def render(%{link: nil} = assigns) do
    ~H"""
    <div class="mk-body share-public share-public--invalid" data-theme-scope>
      <div class="share-public__panel">
        <div class="t-glyph t-glyph--lg ts-serif">T</div>
        <h1>{gettext("share.public.invalid_title")}</h1>
        <p>{gettext("share.public.invalid_sub")}</p>
        <a href={~p"/"} class="ts-btn ts-btn--primary ts-btn--sm">{gettext("share.public.home")}</a>
      </div>
    </div>
    """
  end

  def render(assigns) do
    ~H"""
    <div
      class={["mk-body", "share-public", @embed? && "share-public--embed"]}
      id={if(@embed?, do: "typster-embed")}
      data-theme={@embed_theme}
      data-theme-scope
    >
      <div class={[
        "embed-comp",
        (show_source?(@scope_kind) and @show_preview?) && "embed-comp--split",
        pane_switch?(assigns) && "embed-comp--pane-#{@mobile_pane}"
      ]}>
        <div class="embed-bar">
          <span class="t-glyph ts-serif">T</span>
          <span class="slug truncate">{@project.name}</span>
          <span :if={@entry} class="file truncate">· {@entry.path}</span>
          <span class="spacer"></span>
          <%!-- Copy is the visitor's main action when the owner allows it, so
                it takes primary; when "Edit" is also granted, editing wins
                primary and copy demotes to ghost. Anonymous visitors get the
                same button, same promise — the modal shows the sign-in step. --%>
          <button
            :if={@can_fork?}
            type="button"
            id="shared-fork-open"
            class={[
              "ts-btn",
              "ts-btn--sm",
              "bar-act",
              if(@can_join?, do: "ts-btn--ghost", else: "ts-btn--primary")
            ]}
            title={gettext("share.join.fork")}
            phx-click="open_fork"
          >
            <.icon name="hero-document-duplicate" class="size-3.5" />
            <span class="lbl">{gettext("share.join.fork")}</span>
          </button>
          <%= if @can_join? do %>
            <%= if @current_scope && @current_scope.user do %>
              <button
                type="button"
                id="shared-join"
                class="ts-btn ts-btn--primary ts-btn--sm bar-act"
                title={gettext("share.join.edit")}
                phx-click="join"
              >
                <.icon name="hero-pencil-square" class="size-3.5" />
                <span class="lbl">{gettext("share.join.edit")}</span>
              </button>
            <% else %>
              <.link
                navigate={~p"/users/log-in"}
                id="shared-join-login"
                class="ts-btn ts-btn--primary ts-btn--sm bar-act"
                title={gettext("share.join.edit")}
              >
                <.icon name="hero-pencil-square" class="size-3.5" />
                <span class="lbl">{gettext("share.join.edit")}</span>
              </.link>
            <% end %>
          <% end %>
          <%!-- With action buttons alongside, the pill demotes to icon-only
                (its label moves into the tooltip) so the bar stays quiet. --%>
          <span
            class={[
              "ro-pill",
              scope_pill_tone(@scope_kind),
              @editable? && "ro-pill--edit",
              (@can_fork? or @can_join?) && "ro-pill--compact"
            ]}
            title={if(@editable?, do: gettext("share.scope.sandbox"), else: scope_label(@scope_kind))}
          >
            <.icon
              name={if(@editable?, do: "hero-pencil-square", else: "hero-eye")}
              class="size-3"
            />
            <span :if={not (@can_fork? or @can_join?)}>
              {if(@editable?, do: gettext("share.scope.sandbox"), else: scope_label(@scope_kind))}
            </span>
          </span>
        </div>

        <div :if={@notice} id="shared-notice" class="embed-bar" role="alert">
          <.icon name="hero-exclamation-triangle" class="size-3.5" />
          <span class="truncate">{@notice}</span>
        </div>

        <%!-- Below 640px only one pane fits: a Preview | Source switch picks
              it (CSS hides the switch on wider screens). Not on the embed,
              which has no LiveView socket to push the click over. --%>
        <div :if={pane_switch?(assigns)} id="shared-pane-switch" class="shv-seg" role="tablist">
          <button
            :for={
              {pane, label} <- [
                {"preview", gettext("share.public.pane_preview")},
                {"source", gettext("share.public.pane_source")}
              ]
            }
            type="button"
            id={"shared-pane-#{pane}"}
            role="tab"
            aria-selected={to_string(@mobile_pane == pane)}
            class={["opt", @mobile_pane == pane && "on"]}
            phx-click="set_pane"
            phx-value-pane={pane}
          >
            {label}
          </button>
        </div>

        <%!-- Copy modal — one modal, four internal states (form / invalid /
              busy / failed) plus the anonymous sign-in step. Success is a
              redirect + flash toast in the copy's editor, not a fifth state.
              ⎋ and backdrop click cancel; on mobile it becomes a bottom sheet
              (CSS only). --%>
        <div
          :if={@fork_open?}
          id="shared-fork-overlay"
          class="fk-overlay"
          phx-window-keydown="close_fork"
          phx-key="escape"
        >
          <div class="fk-modal" phx-click-away="close_fork">
            <div
              :if={@fork_busy}
              id="shared-fork-progress"
              class="fk-progressbar"
              style={"width: #{fork_progress_pct(@fork_busy)}%"}
            >
            </div>
            <div class="fk-head">
              <div class="t">
                <div class="ttl">{gettext("share.join.fork_title")}</div>
                <div :if={@current_scope && @current_scope.user} class="sub">
                  {gettext("share.join.fork_sub")}
                </div>
              </div>
              <button
                type="button"
                class="x"
                phx-click="close_fork"
                aria-label={gettext("share.join.fork_cancel")}
              >
                <.icon name="hero-x-mark" class="size-3.5" />
              </button>
            </div>

            <%= if @current_scope && @current_scope.user do %>
              <.form
                for={@fork_form}
                id="shared-fork-form"
                phx-change="fork_change"
                phx-submit="fork"
              >
                <div class="fk-body">
                  <div class="fk-label">{gettext("share.join.fork_name")}</div>
                  <.input
                    field={@fork_form[:name]}
                    type="text"
                    class={if(@fork_error, do: "w-full input invalid", else: "w-full input")}
                    aria-invalid={to_string(@fork_error != nil)}
                    phx-hook="SelectOnMount"
                    disabled={@fork_busy != nil}
                    autofocus
                  />
                  <div :if={@fork_error} id="shared-fork-error" class="fk-err">
                    <.icon name="hero-exclamation-triangle" class="size-3" /> {@fork_error}
                  </div>
                  <div :if={@fork_stats && !@fork_failed? && !@fork_busy} class="fk-meta">
                    <.icon name="hero-folder" class="size-3" /> {fork_meta(@fork_stats)}
                  </div>
                  <%!-- Copying: Files → Assets (with MB) → Open. Done stages
                        go green, the current one spins, future ones wait. --%>
                  <div :if={@fork_busy} id="shared-fork-stages" class="fk-stages" role="status">
                    <%= for {{state, label}, i} <- Enum.with_index(fork_stages(@fork_busy)) do %>
                      <span :if={i > 0} class="sep" aria-hidden="true">→</span>
                      <span class={["st", "st--#{state}"]}>
                        <.icon :if={state == :done} name="hero-check" class="size-3" />
                        <.icon
                          :if={state == :cur}
                          name="hero-arrow-path"
                          class="size-3 motion-safe:animate-spin"
                        />
                        {label}
                      </span>
                    <% end %>
                  </div>
                  <div :if={@fork_failed?} id="shared-fork-failed" class="fk-fail" role="alert">
                    <.icon name="hero-exclamation-triangle" class="size-3.5" />
                    <div class="m">{gettext("share.join.fork_failed")}</div>
                  </div>
                </div>
                <div class="fk-foot">
                  <button type="button" class="cancel" phx-click="close_fork">
                    {gettext("share.join.fork_cancel")}
                  </button>
                  <button
                    type="submit"
                    id="shared-fork-submit"
                    class="ts-btn ts-btn--primary ts-btn--sm"
                    disabled={@fork_busy != nil}
                  >
                    <%= cond do %>
                      <% @fork_busy -> %>
                        <.icon name="hero-arrow-path" class="size-3 motion-safe:animate-spin" /> {gettext(
                          "share.fork.busy"
                        )}
                      <% @fork_failed? -> %>
                        <.icon name="hero-arrow-path" class="size-3" /> {gettext("share.fork.retry")}
                      <% true -> %>
                        <.icon name="hero-document-duplicate" class="size-3" /> {gettext(
                          "share.join.fork_confirm"
                        )}
                    <% end %>
                  </button>
                </div>
              </.form>
            <% else %>
              <div class="fk-anon">
                <div class="badge"><.icon name="hero-document-duplicate" class="size-5" /></div>
                <div class="h">{gettext("share.fork.anon_title")}</div>
                <div class="p">
                  {gettext("share.fork.anon_body", name: @project.name)}
                </div>
              </div>
              <div class="fk-anon-foot">
                <%!-- Full page loads (not `navigate`): the auth pages store
                      `return_to` server-side, so after sign-in the visitor
                      lands back here with the copy modal reopened. --%>
                <.link
                  href={~p"/users/log-in?#{[return_to: fork_return_to(@project, @link)]}"}
                  id="shared-fork-login"
                  class="ts-btn ts-btn--primary"
                >
                  {gettext("share.fork.anon_cta")}
                </.link>
                <.link
                  href={~p"/users/register?#{[return_to: fork_return_to(@project, @link)]}"}
                  id="shared-fork-register"
                  class="ts-btn ts-btn--ghost"
                >
                  {gettext("share.fork.anon_alt")}
                </.link>
              </div>
              <div class="fk-anon-note">{gettext("share.fork.anon_note")}</div>
            <% end %>
          </div>
        </div>

        <section :if={show_source?(@scope_kind)} class="embed-source">
          <div
            id="editor-container"
            phx-hook="CodeMirror"
            phx-update="ignore"
            data-content={@content}
            data-file-id={@entry && @entry.id}
            data-file-name={@entry && @entry.path}
            data-readonly={to_string(!@editable?)}
            data-language={@language}
            data-project-sources={Jason.encode!(@project_sources)}
            data-project-assets="[]"
          >
          </div>
          <div :if={@can_fork? and not @editable?} class="fk-lock-hint">
            <.icon name="hero-lock-closed" class="size-3" /> {gettext("share.fork.lock_hint")}
          </div>
        </section>

        <section :if={@show_preview?} class="embed-preview">
          <div :if={!show_source?(@scope_kind)} class="embed-hidden-src" hidden>
            <div
              id="editor-container"
              phx-hook="CodeMirror"
              phx-update="ignore"
              data-content={@content}
              data-file-id=""
              data-file-name={@entry && @entry.path}
              data-readonly="true"
              data-language={@language}
              data-project-sources={Jason.encode!(@project_sources)}
              data-project-assets="[]"
            >
            </div>
          </div>
          <div
            id="preview-container"
            phx-hook="Preview"
            phx-update="ignore"
            class="ts-preview__scroll"
          >
            <div id="preview-placeholder" class="ts-preview__placeholder">
              <span class="ts-preview__placeholder-ic"><.icon name="hero-eye" class="size-8" /></span>
              <p>{gettext("editor.preview_placeholder")}</p>
            </div>
          </div>
        </section>

        <div :if={!@unbranded? or @cta_mode != :none} class="embed-foot">
          <span :if={!@unbranded?} class="powered">
            {gettext("share.public.powered_by")} <strong class="ts-serif">Typster</strong>
          </span>
          <span class="spacer"></span>
          <%!-- Plain anchors, not `navigate`: the embed renders without a
                LiveView socket, and inside a third-party iframe our session
                cookie is blocked anyway — these must escape to a new
                top-level window on our origin. --%>
          <%= case @cta_mode do %>
            <% :none -> %>
            <% :signup -> %>
              <a
                href={~p"/users/register"}
                target={@embed? && "_blank"}
                rel={@embed? && "noopener"}
                class="embed-foot__cta"
              >
                {gettext("share.embed.cta_signup")}
              </a>
            <% _ -> %>
              <%!-- :open / :fork land on the public share page, where the
                    copy/join actions live — NOT the editor, which bounces
                    everyone but the owner/collaborators with "project
                    unavailable". Embed-only: the /p page has nothing to
                    open (its actions are already in the top bar). --%>
              <a
                :if={@embed?}
                href={~p"/p/#{Sharing.slug(@project)}?#{[key: @link.token]}"}
                target="_blank"
                rel="noopener"
                class="embed-foot__cta"
              >
                {if(@cta_mode == :fork,
                  do: gettext("share.embed.cta_fork"),
                  else: gettext("share.public.open_in_typster")
                )}
              </a>
          <% end %>
        </div>
      </div>
    </div>
    """
  end

  # `?fork=1` has done its job once mount reopened the modal: once connected,
  # patch it out of the address bar (keeping the key), so a refresh or a
  # copied URL doesn't pop the modal open again.
  @impl true
  def handle_params(%{"fork" => _}, uri, %{assigns: %{embed?: false}} = socket) do
    if connected?(socket), do: send(self(), {:drop_fork_param, uri})
    {:noreply, socket}
  end

  def handle_params(_params, _uri, socket), do: {:noreply, socket}

  # Every open starts from the prefilled "{Project} (copy)" name, whatever
  # was typed before Cancel.
  @impl true
  def handle_event("open_fork", _params, %{assigns: %{can_fork?: true}} = socket) do
    {:noreply,
     assign(socket,
       fork_open?: true,
       fork_error: nil,
       fork_failed?: false,
       fork_form: to_form(%{"name" => copy_name(socket.assigns.project.name)}, as: :fork)
     )}
  end

  # Cancel, ⎋ and backdrop click all land here. While copying, the task is
  # killed — its DB transaction rolls back, so nothing is created — and the
  # ForkCleanup safety net enqueued at the start removes any S3 objects it
  # already copied.
  def handle_event("close_fork", _params, socket) do
    {:noreply,
     socket
     |> cancel_fork()
     |> assign(fork_open?: false, fork_error: nil, fork_failed?: false)}
  end

  # The inline name error clears on the first keystroke; the typed value stays.
  def handle_event("fork_change", %{"fork" => %{"name" => name}}, socket) do
    {:noreply,
     socket
     |> assign(:fork_form, to_form(%{"name" => name}, as: :fork))
     |> assign(:fork_error, nil)}
  end

  def handle_event(
        "fork",
        %{"fork" => %{"name" => name}},
        %{assigns: %{can_fork?: true, fork_busy: nil}} = socket
      ) do
    socket = assign(socket, :fork_form, to_form(%{"name" => name}, as: :fork))

    if valid_fork_name?(name) do
      {:noreply, start_fork(socket, name)}
    else
      {:noreply, assign(socket, fork_error: gettext("share.join.fork_invalid_name"))}
    end
  end

  def handle_event("set_pane", %{"pane" => pane}, socket) when pane in ~w(preview source) do
    {:noreply, assign(socket, :mobile_pane, pane)}
  end

  def handle_event("join", _params, %{assigns: %{can_join?: true}} = socket) do
    scope = socket.assigns.current_scope

    case Sharing.join_via_link(scope, socket.assigns.link.token) do
      {:ok, _collaborator_or_owner} ->
        {:noreply, push_navigate(socket, to: ~p"/projects/#{socket.assigns.project.id}/edit")}

      {:error, _reason} ->
        {:noreply, assign(socket, :notice, gettext("share.join.join_failed"))}
    end
  end

  # The public/embed view reuses the editor's client hooks (CodeMirror, Preview),
  # which push compile/outline/save events back to the LiveView. This view is
  # read-only and compiles entirely client-side, so there is no server state to
  # update — we accept and ignore them. Without this clause, the first
  # `update_preview` push would crash the LiveView (undefined handle_event/3).
  # It also swallows join/fork clicks whose policy guard above didn't match.
  def handle_event(_event, _params, socket), do: {:noreply, socket}

  # Progress from the fork task. A message from a cancelled (or earlier) run
  # carries a stale ref and is dropped.
  @impl true
  def handle_info(
        {:fork_progress, ref, event},
        %{assigns: %{fork_busy: %{ref: ref} = busy}} = socket
      ) do
    {:noreply, assign(socket, :fork_busy, advance_fork(busy, event))}
  end

  def handle_info({:fork_progress, _ref, _event}, socket), do: {:noreply, socket}

  def handle_info({:drop_fork_param, uri}, socket) do
    %URI{path: path, query: query} = URI.parse(uri)
    query = query |> URI.decode_query() |> Map.delete("fork") |> URI.encode_query()
    {:noreply, push_patch(socket, to: path <> "?" <> query, replace: true)}
  end

  # Each run is its own async task (`{:fork, ref}`), so a result from a run
  # the visitor cancelled is still delivered here — and told apart from the
  # current run by its ref.
  @impl true
  def handle_async({:fork, ref}, result, %{assigns: %{fork_busy: %{ref: ref}}} = socket) do
    {:noreply, finish_fork(socket, result)}
  end

  # Cancel came after the copy had committed: don't jump into a copy the
  # visitor walked away from, but say it exists.
  def handle_async({:fork, _ref}, {:ok, {:ok, project}}, socket) do
    {:noreply, assign(socket, :notice, gettext("share.fork.cancel_too_late", name: project.name))}
  end

  # A cancelled run's failure or exit: nothing was created, nothing to show.
  def handle_async({:fork, _ref}, _result, socket), do: {:noreply, socket}

  # ── helpers ──────────────────────────────────────────────────────────────
  defp finish_fork(socket, {:ok, {:ok, project}}) do
    socket
    |> assign(:fork_busy, nil)
    |> put_flash(:info, gettext("share.join.forked", name: project.name))
    |> push_navigate(to: ~p"/projects/#{project.id}/edit")
  end

  defp finish_fork(socket, {:ok, {:error, %Ecto.Changeset{}}}) do
    assign(socket,
      fork_busy: nil,
      fork_error: gettext("share.join.fork_invalid_name"),
      fork_failed?: false
    )
  end

  # Stay in the modal: the fail slab explains, the CTA becomes "Try again".
  # Nothing was created, the original is untouched (copied objects are
  # removed by the ForkCleanup safety net).
  defp finish_fork(socket, _error_or_exit) do
    assign(socket, fork_busy: nil, fork_error: nil, fork_failed?: true)
  end

  defp pane_switch?(assigns) do
    not assigns.embed? and assigns.show_preview? and show_source?(assigns.scope_kind)
  end

  defp show_source?(:output), do: false
  defp show_source?(_), do: true

  defp scope_label(:output), do: gettext("share.scope.output")
  defp scope_label(:full), do: gettext("share.scope.full")
  defp scope_label(_), do: gettext("share.scope.read")

  # The "compiled output only" scope gets its own success tone in the bar pill;
  # read/full share the neutral baseline. (Overridden by --edit on Pro sandboxes.)
  defp scope_pill_tone(:output), do: "ro-pill--output"
  defp scope_pill_tone(_), do: nil

  defp entry_file(files) do
    Enum.find(files, &(&1.path == "main.typ")) ||
      Enum.find(files, &(Files.editor_language(&1.path) == "typst")) ||
      List.first(files)
  end

  defp entry_language(nil), do: "typst"
  defp entry_language(%{path: path}), do: Files.editor_language(path)

  # "{Project} (copy)", shortened with "…" when the source name is so long
  # that the suffix would push it past the column limit.
  defp copy_name(name) do
    full = gettext("share.join.copy_of", name: name)
    overflow = codepoint_count(full) - Typster.Projects.Project.name_max()

    if overflow > 0 do
      keep = codepoint_count(name) - overflow - 1
      short = name |> String.codepoints() |> Enum.take(keep) |> Enum.join()
      gettext("share.join.copy_of", name: short <> "…")
    else
      full
    end
  end

  defp codepoint_count(string), do: string |> String.codepoints() |> length()

  # Only the instant check (blank) runs here, so an empty name never starts a
  # task; every other rule (e.g. length) comes back from the copy's changeset
  # as the same inline error.
  defp valid_fork_name?(name), do: String.trim(name) != ""

  # Runs the copy in a task so the modal can show live stages and Cancel can
  # kill it. The task reports progress back to this LiveView, tagged with a
  # per-run ref.
  defp start_fork(socket, name) do
    %{current_scope: scope, link: link, fork_stats: stats} = socket.assigns
    lv = self()
    ref = make_ref()
    progress = fn event -> send(lv, {:fork_progress, ref, event}) end

    socket
    |> assign(fork_error: nil, fork_failed?: false)
    |> assign(:fork_busy, %{
      ref: ref,
      stage: :files,
      done_bytes: 0,
      total_bytes: (stats && stats.bytes) || 0
    })
    |> start_async({:fork, ref}, fn ->
      result = Sharing.fork_via_link(scope, link.token, %{name: name}, on_progress: progress)
      if match?({:ok, _}, result), do: progress.(:open)
      result
    end)
  end

  defp cancel_fork(%{assigns: %{fork_busy: nil}} = socket), do: socket

  defp cancel_fork(%{assigns: %{fork_busy: %{ref: ref}}} = socket) do
    socket
    |> cancel_async({:fork, ref}, {:shutdown, :cancel})
    |> assign(:fork_busy, nil)
  end

  defp advance_fork(busy, {:files}), do: %{busy | stage: :assets}

  defp advance_fork(busy, {:assets, done, total}),
    do: %{busy | stage: :assets, done_bytes: done, total_bytes: total}

  defp advance_fork(busy, :open), do: %{busy | stage: :open}

  # 2px bar on the modal edge: files ≈ 25%, assets 25–90% by bytes, open 95%.
  defp fork_progress_pct(%{stage: :files}), do: 25
  defp fork_progress_pct(%{stage: :open}), do: 95
  defp fork_progress_pct(%{total_bytes: total}) when total <= 0, do: 90

  defp fork_progress_pct(%{done_bytes: done, total_bytes: total}),
    do: 25 + round(65 * done / total)

  @fork_stage_order [:files, :assets, :open]

  defp fork_stages(%{stage: current} = busy) do
    current_index = Enum.find_index(@fork_stage_order, &(&1 == current))

    @fork_stage_order
    |> Enum.with_index()
    |> Enum.map(fn {stage, index} ->
      state =
        cond do
          index < current_index -> :done
          index == current_index -> :cur
          true -> :todo
        end

      {state, fork_stage_label(stage, busy)}
    end)
  end

  defp fork_stage_label(:files, _busy), do: gettext("share.fork.stage_files")
  defp fork_stage_label(:open, _busy), do: gettext("share.fork.stage_open")

  defp fork_stage_label(:assets, %{total_bytes: total}) when total <= 0,
    do: gettext("share.fork.stage_assets_empty")

  # "Assets · 2.1 of 3.4 MB": both figures in the total's unit, the unit once
  # (and localized). Below 1 MB the unit is KB, so no bare "B" ever shows.
  defp fork_stage_label(:assets, %{done_bytes: done, total_bytes: total})
       when total >= 1_048_576 do
    gettext("share.fork.stage_assets_mb",
      done: one_decimal(done / 1_048_576),
      total: one_decimal(total / 1_048_576)
    )
  end

  defp fork_stage_label(:assets, %{done_bytes: done, total_bytes: total}) do
    gettext("share.fork.stage_assets_kb",
      done: one_decimal(done / 1024),
      total: one_decimal(total / 1024)
    )
  end

  defp one_decimal(number), do: :erlang.float_to_binary(number / 1, decimals: 1)

  # `?fork=1` (the post-sign-in return target) reopens the copy form — for a
  # signed-in visitor on a link that allows copying, never anyone else.
  defp reopen_fork?(socket, can_fork?, params) do
    can_fork? and params["fork"] == "1" and match?(%{current_scope: %{user: %{}}}, socket.assigns)
  end

  # Where an anonymous visitor lands after signing in: this share page with
  # the copy modal reopened (`fork=1`). It opens the form only — a GET never
  # creates the copy, so a refresh cannot double-fork.
  defp fork_return_to(project, link) do
    ~p"/p/#{Sharing.slug(project)}?#{[key: link.token, fork: 1]}"
  end

  # "12 files · 4 assets · 3.4 MB — copying takes a few seconds". The size
  # segment drops out below 1 KB rather than showing a noisy "0.0 KB".
  defp fork_meta(%{files: files, assets: assets, bytes: bytes}) do
    what =
      [
        ngettext("share.fork.meta_files.one", "share.fork.meta_files.other", files),
        ngettext("share.fork.meta_assets.one", "share.fork.meta_assets.other", assets),
        format_bytes(bytes)
      ]
      |> Enum.reject(&is_nil/1)
      |> Enum.join(" · ")

    gettext("share.fork.meta", what: what)
  end

  defp format_bytes(bytes) when bytes >= 1_048_576, do: "#{Float.round(bytes / 1_048_576, 1)} MB"
  defp format_bytes(bytes) when bytes >= 1024, do: "#{Float.round(bytes / 1024, 1)} KB"
  defp format_bytes(_), do: nil

  defp project_sources(files) do
    files
    |> Enum.filter(&Files.editable_file?/1)
    |> Enum.map(fn f ->
      %{path: f.path, content: f.content || "", language: Files.editor_language(f.path)}
    end)
  end
end
