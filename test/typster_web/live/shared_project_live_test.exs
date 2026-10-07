defmodule TypsterWeb.SharedProjectLiveTest do
  use TypsterWeb.ConnCase, async: true
  use Oban.Testing, repo: Typster.Repo

  import Phoenix.LiveViewTest
  import Typster.ProjectsFixtures

  alias Typster.Accounts.Scope
  alias Typster.Sharing

  setup do
    owner = Typster.AccountsFixtures.user_fixture()
    scope = Scope.for_user(owner)
    project = project_fixture(owner)
    file_fixture(project, owner, %{path: "main.typ", content: "= Hi"})
    link = Sharing.get_or_create_link(scope, project.id)

    %{owner: owner, scope: scope, project: project, link: link}
  end

  describe ":read scope via /p" do
    test "renders the split read-only comp with source, preview and chrome", %{
      conn: conn,
      project: project,
      link: link
    } do
      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")

      # Split layout (source + preview side by side).
      assert has_element?(view, ".embed-comp.embed-comp--split")
      # Read-only CodeMirror source pane is shown.
      assert has_element?(view, ".embed-source #editor-container")
      # Live preview pane.
      assert has_element?(view, ".embed-preview #preview-container")
      # Top bar shows the project name and the read-only pill.
      assert has_element?(view, ".embed-bar .slug", project.name)
      assert has_element?(view, ".ro-pill")
      # No footer CTA on the top-level /p page — its actions (copy/join)
      # already live in the top bar, and the editor URL would bounce
      # everyone but the owner.
      refute has_element?(view, ".embed-foot__cta")
    end

    test "the mobile Preview | Source switch picks the visible pane", %{conn: conn, link: link} do
      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")

      # Preview is the default pane (CSS shows the switch below 640px only).
      assert has_element?(view, ~s|#shared-pane-preview.on[aria-selected="true"]|)
      assert has_element?(view, ".embed-comp.embed-comp--pane-preview")

      view |> element("#shared-pane-source") |> render_click()
      assert has_element?(view, ~s|#shared-pane-source.on[aria-selected="true"]|)
      assert has_element?(view, ".embed-comp.embed-comp--pane-source")
    end
  end

  describe ":output scope via /p" do
    test "hides the source pane but keeps the preview", %{
      conn: conn,
      scope: scope,
      link: link
    } do
      {:ok, _link} = Sharing.update_link(scope, link, %{scope: :output})

      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")

      # Not a split layout when the source is hidden.
      refute has_element?(view, ".embed-comp.embed-comp--split")
      # The visible source section is gone (only a hidden mirror remains).
      refute has_element?(view, ".embed-source #editor-container")
      # Preview is still rendered.
      assert has_element?(view, ".embed-preview #preview-container")
      # Nothing to switch to on mobile.
      refute has_element?(view, "#shared-pane-switch")
    end
  end

  describe "invalid link" do
    test "renders the invalid panel and no embed comp", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: "does-not-exist"]}")

      assert has_element?(view, ".share-public--invalid .share-public__panel")
      refute has_element?(view, ".embed-comp")
    end
  end

  describe "/embed/:token" do
    test "mounts the embed variant", %{conn: conn, link: link, project: project} do
      {:ok, view, _html} = live(conn, ~p"/embed/#{link.token}")

      assert has_element?(view, ".share-public--embed")
      assert has_element?(view, ".embed-comp")
      # No socket-driven pane switch inside third-party iframes.
      refute has_element?(view, "#shared-pane-switch")

      # The CTA must escape the host iframe to a new top-level window on our
      # site — onto the public share page (the editor would bounce anyone
      # without edit access), keyed by the link token.
      slug = Sharing.slug(project)

      assert has_element?(
               view,
               ~s|a.embed-foot__cta[target="_blank"][rel="noopener"][href="/p/#{slug}?key=#{link.token}"]|
             )
    end
  end

  describe "read-only client hook events" do
    test "tolerates preview hook pushes without crashing", %{conn: conn, link: link} do
      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")

      # The CodeMirror/Preview hooks push these editor events; the read-only
      # view must swallow them via its catch-all handle_event/3.
      render_hook(view, "update_preview", %{"ms" => 12, "pages" => 1})
      render_hook(view, "preview_error", %{"message" => "x", "errors" => 1})

      # If the catch-all clause were missing, the pushes above would have
      # crashed the LiveView and this assertion would fail.
      assert has_element?(view, ".embed-comp")
    end
  end

  describe "fork via /p" do
    test "a signed-in visitor copies the project into their account", %{
      conn: conn,
      scope: scope,
      link: link
    } do
      {:ok, link} = Sharing.update_link(scope, link, %{allow_fork: true})
      visitor = Typster.AccountsFixtures.user_fixture()
      conn = log_in_user(conn, visitor)

      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")

      assert has_element?(view, "#shared-fork-open")
      # The label sits in its own span (hidden below 720px) and the title
      # carries it as a tooltip.
      assert has_element?(view, "#shared-fork-open[title] .lbl")
      view |> element("#shared-fork-open") |> render_click()

      # The prefilled "(copy)" name is focused + selected by the hook on open.
      assert has_element?(view, ~s|#shared-fork-form input[phx-hook="SelectOnMount"]|)

      html =
        view
        |> form("#shared-fork-form", fork: %{name: "Fork of the century"})
        |> render_submit()

      # Copying runs async: the reply shows the locked, staged busy state.
      busy = LazyHTML.from_fragment(html)
      assert LazyHTML.query(busy, "#shared-fork-stages .st--cur") |> Enum.count() == 1
      assert LazyHTML.query(busy, "#shared-fork-progress") |> Enum.count() == 1
      assert LazyHTML.query(busy, "#shared-fork-submit[disabled]") |> Enum.count() == 1

      # The async result navigates to the copy (the view then shuts down, so
      # wait for the redirect instead of calling render_async/1).
      {path, flash} = assert_redirect(view, 2_000)
      assert path =~ ~r"^/projects/[0-9a-f-]+/edit$"
      assert flash["info"] =~ "Fork of the century"
    end

    test "a failed copy shows the fail slab and offers a retry", %{
      conn: conn,
      scope: scope,
      project: project,
      link: link
    } do
      # An asset whose S3 object is missing makes the copy fail mid-way.
      asset_fixture(project, scope)
      {:ok, link} = Sharing.update_link(scope, link, %{allow_fork: true})
      visitor = Typster.AccountsFixtures.user_fixture()
      conn = log_in_user(conn, visitor)

      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")
      view |> element("#shared-fork-open") |> render_click()
      view |> form("#shared-fork-form", fork: %{name: "Unlucky"}) |> render_submit()
      # The copy fails on a missing S3 object; give the client's retries room.
      render_async(view, 5_000)

      assert has_element?(view, "#shared-fork-failed")
      assert has_element?(view, "#shared-fork-submit:not([disabled])")
      refute has_element?(view, "#shared-fork-stages")
      assert Typster.Projects.list_projects(Scope.for_user(visitor)) == []

      # The safety net enqueued at the start removes any copied objects.
      assert_enqueued(worker: Typster.Jobs.ForkCleanup)
    end

    test "cancel while copying aborts the copy and closes the modal", %{
      conn: conn,
      scope: scope,
      link: link
    } do
      {:ok, link} = Sharing.update_link(scope, link, %{allow_fork: true})
      visitor = Typster.AccountsFixtures.user_fixture()
      conn = log_in_user(conn, visitor)

      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")
      view |> element("#shared-fork-open") |> render_click()

      # Hold the sandboxed connection so the copy task cannot reach the DB
      # until Cancel has been pressed — makes the race deterministic.
      Typster.Repo.transaction(fn ->
        view |> form("#shared-fork-form", fork: %{name: "Never mind"}) |> render_submit()
        view |> element("#shared-fork-form button.cancel") |> render_click()
        refute has_element?(view, "#shared-fork-overlay")
      end)

      render_async(view)
      refute has_element?(view, "#shared-fork-overlay")
      assert Typster.Projects.list_projects(Scope.for_user(visitor)) == []
    end

    test "a copy that commits after Cancel doesn't navigate, it says so", %{
      conn: conn,
      scope: scope,
      link: link
    } do
      {:ok, link} = Sharing.update_link(scope, link, %{allow_fork: true})
      visitor = Typster.AccountsFixtures.user_fixture()
      conn = log_in_user(conn, visitor)

      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")
      view |> element("#shared-fork-open") |> render_click()

      Typster.Repo.transaction(fn ->
        view |> form("#shared-fork-form", fork: %{name: "Too late"}) |> render_submit()

        # Cancel lands after the copy committed but before its result is
        # processed: the run is no longer current, yet its task finishes.
        :sys.replace_state(view.pid, fn state ->
          update_in(
            state.socket,
            &Phoenix.Component.assign(&1, fork_busy: nil, fork_open?: false)
          )
        end)
      end)

      render_async(view)
      assert has_element?(view, "#shared-notice", "Too late")
      refute has_element?(view, "#shared-fork-overlay")
      assert [%{name: "Too late"}] = Typster.Projects.list_projects(Scope.for_user(visitor))
    end

    test "the assets stage shows bytes in one unit and drives the bar", %{
      conn: conn,
      scope: scope,
      link: link
    } do
      {:ok, link} = Sharing.update_link(scope, link, %{allow_fork: true})
      conn = log_in_user(conn, Typster.AccountsFixtures.user_fixture())

      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")
      view |> element("#shared-fork-open") |> render_click()

      Typster.Repo.transaction(fn ->
        view |> form("#shared-fork-form", fork: %{name: "Bytes"}) |> render_submit()
        ref = fork_ref(view)

        send(view.pid, {:fork_progress, ref, {:files}})
        send(view.pid, {:fork_progress, ref, {:assets, 1_048_576, 4_194_304}})
        assert has_element?(view, "#shared-fork-stages .st--done", "Files")
        assert has_element?(view, "#shared-fork-stages .st--cur", "Assets · 1.0 of 4.0 MB")
        # 25% + 65% × ¼ of the bytes.
        assert has_element?(view, ~s|#shared-fork-progress[style="width: 41%"]|)

        send(view.pid, {:fork_progress, ref, {:assets, 512, 2048}})
        assert has_element?(view, "#shared-fork-stages .st--cur", "Assets · 0.5 of 2.0 KB")

        view |> element("#shared-fork-form button.cancel") |> render_click()
      end)
    end

    test "late progress from a cancelled run is ignored", %{
      conn: conn,
      scope: scope,
      link: link
    } do
      {:ok, link} = Sharing.update_link(scope, link, %{allow_fork: true})
      conn = log_in_user(conn, Typster.AccountsFixtures.user_fixture())

      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")
      view |> element("#shared-fork-open") |> render_click()

      # Idle modal: nothing to advance.
      send(view.pid, {:fork_progress, make_ref(), {:assets, 1, 2}})
      refute has_element?(view, "#shared-fork-stages")
      assert has_element?(view, "#shared-fork-form .fk-meta")

      # Busy with a newer run: a foreign ref must not move its stages.
      Typster.Repo.transaction(fn ->
        view |> form("#shared-fork-form", fork: %{name: "Current"}) |> render_submit()

        send(view.pid, {:fork_progress, make_ref(), {:files}})
        send(view.pid, {:fork_progress, make_ref(), {:assets, 1, 2}})
        assert has_element?(view, "#shared-fork-stages .st--cur", "Files")
        refute has_element?(view, "#shared-fork-stages .st--done")
        assert has_element?(view, ~s|#shared-fork-progress[style="width: 25%"]|)

        view |> element("#shared-fork-form button.cancel") |> render_click()
      end)
    end

    test "a copy that crashes shows the fail slab", %{
      conn: conn,
      scope: scope,
      project: project,
      link: link
    } do
      # A file whose parent lives in another project can't be re-linked in
      # the copy: copying it raises inside the task.
      stranger = Typster.AccountsFixtures.user_fixture()
      stray = file_fixture(project_fixture(stranger), stranger)

      Typster.Repo.insert!(%Typster.Projects.File{
        project_id: project.id,
        path: "orphan.typ",
        parent_id: stray.id
      })

      {:ok, link} = Sharing.update_link(scope, link, %{allow_fork: true})
      visitor = Typster.AccountsFixtures.user_fixture()
      conn = log_in_user(conn, visitor)

      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")
      view |> element("#shared-fork-open") |> render_click()

      ExUnit.CaptureLog.capture_log(fn ->
        view |> form("#shared-fork-form", fork: %{name: "Crash"}) |> render_submit()
        render_async(view)
      end)

      assert has_element?(view, "#shared-fork-failed")
      refute has_element?(view, "#shared-fork-stages")
      assert Typster.Projects.list_projects(Scope.for_user(visitor)) == []
    end

    test "an empty name shows the inline error and keeps the modal open", %{
      conn: conn,
      scope: scope,
      link: link
    } do
      {:ok, link} = Sharing.update_link(scope, link, %{allow_fork: true})
      visitor = Typster.AccountsFixtures.user_fixture()
      conn = log_in_user(conn, visitor)

      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")

      view |> element("#shared-fork-open") |> render_click()

      view
      |> form("#shared-fork-form", fork: %{name: ""})
      |> render_submit()

      # Inline error under the field — no dialog, no closed modal.
      assert has_element?(view, "#shared-fork-error")
      assert has_element?(view, "#shared-fork-form")
    end

    test "a name the copy's changeset rejects comes back as the inline error", %{
      conn: conn,
      scope: scope,
      link: link
    } do
      {:ok, link} = Sharing.update_link(scope, link, %{allow_fork: true})
      visitor = Typster.AccountsFixtures.user_fixture()
      conn = log_in_user(conn, visitor)

      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")
      view |> element("#shared-fork-open") |> render_click()

      too_long = String.duplicate("x", 256)
      view |> form("#shared-fork-form", fork: %{name: too_long}) |> render_submit()
      render_async(view)

      # Not the "couldn't copy, try again" slab: retrying would never help.
      assert has_element?(view, "#shared-fork-error")
      refute has_element?(view, "#shared-fork-failed")
      assert Typster.Projects.list_projects(Scope.for_user(visitor)) == []
    end

    test "a near-limit project name still prefills a copy name that fits", %{
      conn: conn,
      scope: scope,
      project: project,
      link: link
    } do
      {:ok, _} =
        Typster.Projects.update_project(scope, project, %{name: String.duplicate("n", 250)})

      {:ok, link} = Sharing.update_link(scope, link, %{allow_fork: true})
      conn = log_in_user(conn, Typster.AccountsFixtures.user_fixture())

      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")
      view |> element("#shared-fork-open") |> render_click()

      [value] =
        view
        |> render()
        |> LazyHTML.from_fragment()
        |> LazyHTML.query(~s|#shared-fork-form input[name="fork[name]"]|)
        |> LazyHTML.attribute("value")

      assert String.length(value) == 255
      assert value =~ ~r/…\s*\(copy\)$/u
    end

    test "the inline name error clears on the first keystroke", %{
      conn: conn,
      scope: scope,
      link: link
    } do
      {:ok, link} = Sharing.update_link(scope, link, %{allow_fork: true})
      conn = log_in_user(conn, Typster.AccountsFixtures.user_fixture())

      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")
      view |> element("#shared-fork-open") |> render_click()

      view |> form("#shared-fork-form", fork: %{name: ""}) |> render_submit()
      assert has_element?(view, "#shared-fork-error")
      assert has_element?(view, ~s|#shared-fork-form input.invalid[aria-invalid="true"]|)

      view |> form("#shared-fork-form", fork: %{name: "M"}) |> render_change()
      refute has_element?(view, "#shared-fork-error")
      refute has_element?(view, "#shared-fork-form input.invalid")
      assert has_element?(view, ~s|#shared-fork-form input[name="fork[name]"][value="M"]|)
    end

    test "anonymous visitors get the sign-in step in the same modal", %{
      conn: conn,
      scope: scope,
      project: project,
      link: link
    } do
      {:ok, link} = Sharing.update_link(scope, link, %{allow_fork: true})

      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")

      # Same button, same promise — the modal handles authentication.
      assert has_element?(view, "#shared-fork-open")
      view |> element("#shared-fork-open") |> render_click()

      # Sign-in and sign-up carry this page (with the modal reopened) as the
      # post-auth destination.
      return_to = URI.encode_www_form("/p/#{Sharing.slug(project)}?key=#{link.token}&fork=1")

      assert has_element?(
               view,
               ~s|#shared-fork-login[href="/users/log-in?return_to=#{return_to}"]|
             )

      assert has_element?(
               view,
               ~s|#shared-fork-register[href="/users/register?return_to=#{return_to}"]|
             )

      refute has_element?(view, "#shared-fork-form")
    end

    test "?fork=1 reopens the copy form for a signed-in visitor", %{
      conn: conn,
      scope: scope,
      link: link
    } do
      {:ok, link} = Sharing.update_link(scope, link, %{allow_fork: true})
      visitor = Typster.AccountsFixtures.user_fixture()
      conn = log_in_user(conn, visitor)

      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token, fork: 1]}")

      # The form opens prefilled; nothing is copied until the visitor presses Copy.
      assert has_element?(view, "#shared-fork-form")
      assert has_element?(view, ~s|#shared-fork-form input[name="fork[name]"][value$="(copy)"]|)
      assert Typster.Projects.list_projects(Scope.for_user(visitor)) == []

      # fork=1 leaves the address bar, so a refresh won't reopen the modal.
      assert_patch(view, "/p/shared?#{URI.encode_query(%{"key" => link.token})}")
      assert has_element?(view, "#shared-fork-form")
    end

    test "reopening the modal restores the prefilled name", %{
      conn: conn,
      scope: scope,
      link: link
    } do
      {:ok, link} = Sharing.update_link(scope, link, %{allow_fork: true})
      conn = log_in_user(conn, Typster.AccountsFixtures.user_fixture())

      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")
      view |> element("#shared-fork-open") |> render_click()
      view |> form("#shared-fork-form", fork: %{name: ""}) |> render_change()
      view |> element("#shared-fork-form button.cancel") |> render_click()

      view |> element("#shared-fork-open") |> render_click()
      assert has_element?(view, ~s|#shared-fork-form input[name="fork[name]"][value$="(copy)"]|)
    end

    test "?fork=1 is ignored for anonymous visitors and when copying is off", %{
      conn: conn,
      scope: scope,
      link: link
    } do
      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token, fork: 1]}")
      refute has_element?(view, "#shared-fork-overlay")

      signed_in = log_in_user(conn, Typster.AccountsFixtures.user_fixture())
      {:ok, view, _html} = live(signed_in, ~p"/p/shared?#{[key: link.token, fork: 1]}")
      refute has_element?(view, "#shared-fork-overlay")

      {:ok, link} = Sharing.update_link(scope, link, %{allow_fork: true})
      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token, fork: 1]}")
      refute has_element?(view, "#shared-fork-overlay")
    end

    test "no copy affordance while allow_fork is off (the default)", %{
      conn: conn,
      link: link
    } do
      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")

      refute has_element?(view, "#shared-fork-open")
      refute has_element?(view, "#shared-fork-login")
    end
  end

  # The current copy run's ref, as the LiveView tags its progress messages.
  defp fork_ref(view), do: :sys.get_state(view.pid).socket.assigns.fork_busy.ref

  describe "project fonts on the share page" do
    test "the preview gets the project's fonts with presigned URLs, nothing else", %{
      conn: conn,
      owner: owner,
      project: project,
      link: link
    } do
      font = asset_fixture(project, owner, %{filename: "Brand.ttf", content_type: "font/ttf"})
      asset_fixture(project, owner, %{filename: "logo.png"})

      {:ok, view, _html} = live(conn, ~p"/p/shared?#{[key: link.token]}")

      manifest =
        view
        |> element("#editor-container")
        |> render()
        |> LazyHTML.from_fragment()
        |> LazyHTML.attribute("data-project-assets")
        |> List.first()
        |> Jason.decode!()

      assert [%{"kind" => "font", "reference_path" => "assets/Brand.ttf", "url" => url}] =
               manifest

      assert url == "/p/#{Typster.Sharing.slug(project)}/assets/#{font.id}?key=#{link.token}"
    end
  end
end
