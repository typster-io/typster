defmodule TypsterWeb.SharedProjectLiveTest do
  use TypsterWeb.ConnCase, async: true

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

      view
      |> form("#shared-fork-form", fork: %{name: "Fork of the century"})
      |> render_submit()

      {path, _flash} = assert_redirect(view)
      assert path =~ ~r"^/projects/[0-9a-f-]+/edit$"
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
end
