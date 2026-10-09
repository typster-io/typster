defmodule TypsterWeb.ProjectLiveTest do
  use TypsterWeb.ConnCase, async: true

  import Phoenix.LiveViewTest
  import Typster.ProjectsFixtures

  test "projects routes redirect when unauthenticated", %{conn: conn} do
    assert {:error, {:redirect, %{to: "/users/log-in"}}} = live(conn, ~p"/projects")
  end

  test "project index only shows the current user's projects", %{conn: conn} do
    user = conn.assigns[:user] || Typster.AccountsFixtures.user_fixture()
    other_user = Typster.AccountsFixtures.user_fixture()
    conn = log_in_user(conn, user)

    project_fixture(user, %{name: "Visible Project"})
    project_fixture(other_user, %{name: "Hidden Project"})

    {:ok, _view, html} = live(conn, ~p"/projects")

    assert html =~ "Visible Project"
    refute html =~ "Hidden Project"
  end

  test "project index renders the filter segments and a serif heading", %{conn: conn} do
    user = Typster.AccountsFixtures.user_fixture()
    conn = log_in_user(conn, user)

    {:ok, view, _html} = live(conn, ~p"/projects")

    assert has_element?(view, "h1 .ts-serif")
    assert has_element?(view, "#filter-all.is-active")
    assert has_element?(view, "#filter-recent")
    assert has_element?(view, "#filter-starred")
  end

  test "filtering to starred shows the empty state", %{conn: conn} do
    user = Typster.AccountsFixtures.user_fixture()
    conn = log_in_user(conn, user)
    project_fixture(user, %{name: "Visible Project"})

    {:ok, view, _html} = live(conn, ~p"/projects")
    assert render(view) =~ "Visible Project"

    view |> element("#filter-starred") |> render_click()

    refute render(view) =~ "Visible Project"
    assert has_element?(view, "#filter-starred.is-active")
  end

  describe "template library" do
    setup %{conn: conn} do
      user = Typster.AccountsFixtures.user_fixture()
      %{conn: log_in_user(conn, user), user: user, scope: Typster.Accounts.Scope.for_user(user)}
    end

    test "a dropped text source is saved and listed", %{conn: conn, scope: scope} do
      {:ok, view, _html} = live(conn, ~p"/projects")
      assert has_element?(view, "#templates-panel #template-upload-form")

      input =
        file_input(view, "#template-upload-form", :template, [
          %{name: "ieee.typ", content: "= IEEE paper", type: "text/plain"}
        ])

      render_upload(input, "ieee.typ")

      assert [%{name: "ieee.typ", content: "= IEEE paper"}] =
               Typster.Templates.list_templates(scope)

      assert has_element?(view, "#templates-panel .ts-tpl__row", "ieee.typ")
      assert render(view) =~ "Template saved."
    end

    test "binaries and unknown extensions are refused", %{conn: conn, scope: scope} do
      {:ok, view, _html} = live(conn, ~p"/projects")

      input =
        file_input(view, "#template-upload-form", :template, [
          %{name: "logo.png", content: <<137, 80, 78, 71>>, type: "image/png"}
        ])

      render_upload(input, "logo.png")

      assert Typster.Templates.list_templates(scope) == []
      refute has_element?(view, "#templates-panel .ts-tpl__row")
      assert render(view) =~ "Only text sources"
    end

    test "a template can be removed from the list", %{conn: conn, scope: scope} do
      {:ok, tpl} = Typster.Templates.create_template(scope, %{name: "cv.typ", content: "= CV"})
      {:ok, view, _html} = live(conn, ~p"/projects")

      view |> element("#template-#{tpl.id} button[phx-click='delete_template']") |> render_click()

      refute has_element?(view, "#template-#{tpl.id}")
      assert Typster.Templates.list_templates(scope) == []
    end

    test "a new project can start from a template as main.typ", %{conn: conn, scope: scope} do
      {:ok, tpl} =
        Typster.Templates.create_template(scope, %{name: "ieee.typ", content: "= From tpl"})

      {:ok, view, _html} = live(conn, ~p"/projects")

      view |> element("#new-project-button") |> render_click()
      assert has_element?(view, "#new-project-template option[value='#{tpl.id}']")

      view
      |> form("#new-project-form", %{name: "Seeded", template: tpl.id})
      |> render_submit()

      project = Enum.find(Typster.Projects.list_projects(scope), &(&1.name == "Seeded"))

      assert [%{path: "main.typ", content: "= From tpl"}] =
               Typster.Files.get_file_tree(scope, project.id)
    end

    test "a blank choice creates an empty project and the picker hides without templates",
         %{conn: conn, scope: scope} do
      {:ok, view, _html} = live(conn, ~p"/projects")
      view |> element("#new-project-button") |> render_click()
      refute has_element?(view, "#new-project-template")

      view |> form("#new-project-form", %{name: "Blank"}) |> render_submit()

      project = Enum.find(Typster.Projects.list_projects(scope), &(&1.name == "Blank"))
      assert Typster.Files.get_file_tree(scope, project.id) == []
    end
  end

  test "editor prefers main.typ as the selected file", %{conn: conn} do
    user = Typster.AccountsFixtures.user_fixture()
    conn = log_in_user(conn, user)
    project = project_fixture(user)
    main_file = file_fixture(project, user, %{path: "main.typ", content: "= Main"})
    _other_file = file_fixture(project, user, %{path: "appendix.typ", content: "= Appendix"})

    {:ok, view, _html} = live(conn, ~p"/projects/#{project.id}/edit")

    assert has_element?(view, "#editor-container[data-file-id=\"#{main_file.id}\"]")
  end

  test "editor renders the format toolbar and opens the command palette", %{conn: conn} do
    user = Typster.AccountsFixtures.user_fixture()
    conn = log_in_user(conn, user)
    project = project_fixture(user)
    file_fixture(project, user, %{path: "main.typ", content: "= Main"})

    {:ok, view, _html} = live(conn, ~p"/projects/#{project.id}/edit")

    assert has_element?(view, "#editor-shell .ts-formatbar")
    assert has_element?(view, ".ts-preview__bar .ts-pill")
    refute has_element?(view, "#command-palette")

    view |> element("button.ts-tb__omni") |> render_click()

    assert has_element?(view, "#command-palette")
    assert has_element?(view, "#command-palette #palette-input")
  end

  test "show page lists uploaded assets", %{conn: conn} do
    user = Typster.AccountsFixtures.user_fixture()
    conn = log_in_user(conn, user)
    project = project_fixture(user)
    _asset = asset_fixture(project, user, %{filename: "diagram.png"})

    {:ok, view, _html} = live(conn, ~p"/projects/#{project.id}")

    assert has_element?(view, "#project-files")
    assert has_element?(view, "#project-files li", "diagram.png")
  end

  describe "projects shared with the current user" do
    setup %{conn: conn} do
      owner = Typster.AccountsFixtures.user_fixture()
      member = Typster.AccountsFixtures.user_fixture()
      owner_scope = Typster.Accounts.Scope.for_user(owner)
      shared = project_fixture(owner, %{name: "Shared With Me"})
      mine = project_fixture(member, %{name: "My Own Project"})
      # Invite the member by email only — no accept-link click. Visiting their
      # project list should be enough to surface it.
      {:ok, _} =
        Typster.Sharing.invite_collaborator(owner_scope, shared.id, member.email, :editor)

      %{conn: log_in_user(conn, member), shared: shared, mine: mine}
    end

    test "appears in the list, badged as Shared, after visiting /projects", %{
      conn: conn,
      shared: shared,
      mine: mine
    } do
      {:ok, view, _html} = live(conn, ~p"/projects")

      assert has_element?(view, "##{dom_id(shared)} .ts-list__title", "Shared With Me")
      assert has_element?(view, "##{dom_id(shared)} .ts-shared-badge")
      # The user's own project carries no Shared badge.
      assert has_element?(view, "##{dom_id(mine)} .ts-list__title", "My Own Project")
      refute has_element?(view, "##{dom_id(mine)} .ts-shared-badge")
    end

    test "offers no delete button on a project the user doesn't own", %{
      conn: conn,
      shared: shared,
      mine: mine
    } do
      {:ok, view, _html} = live(conn, ~p"/projects")

      refute has_element?(view, "#delete-project-#{shared.id}")
      assert has_element?(view, "#delete-project-#{mine.id}")
    end
  end

  # LiveView streams prefix the DOM id with the stream name (`projects-<id>`).
  defp dom_id(project), do: "projects-#{project.id}"
end
