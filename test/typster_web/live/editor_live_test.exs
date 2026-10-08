defmodule TypsterWeb.EditorLiveTest do
  use TypsterWeb.ConnCase, async: true

  import Phoenix.LiveViewTest
  import Typster.ProjectsFixtures

  setup %{conn: conn} do
    user = Typster.AccountsFixtures.user_fixture()
    conn = log_in_user(conn, user)
    project = project_fixture(user, %{name: "Quarterly Report"})
    %{conn: conn, user: user, project: project}
  end

  defp open_editor(conn, project) do
    {:ok, view, _html} = live(conn, ~p"/projects/#{project.id}/edit")
    view
  end

  test "a stranger's project URL redirects to /projects instead of a 500", %{conn: conn} do
    stranger_project = project_fixture(Typster.AccountsFixtures.user_fixture())

    # Same response for "no access" and "doesn't exist" — no existence leak.
    assert {:error, {:live_redirect, %{to: "/projects"}}} =
             live(conn, ~p"/projects/#{stranger_project.id}/edit")

    assert {:error, {:live_redirect, %{to: "/projects"}}} =
             live(conn, ~p"/projects/#{Ecto.UUID.generate()}/edit")
  end

  test "the new-file button reveals an inline draft row", %{conn: conn, project: project} do
    view = open_editor(conn, project)

    refute has_element?(view, "#new-file-draft")
    view |> element("#create-main-file-button") |> render_click()
    assert has_element?(view, "#new-file-draft #new-file-form")
  end

  test "typing a plain name suggests the project's majority source extension",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    view |> element("#create-main-file-button") |> render_click()
    html = view |> form("#new-file-form", %{path: "conclusion"}) |> render_change()

    # The "+ .typ" hint pill is shown, no explicit extension chips for a single suggestion.
    assert html =~ "+ .typ"
    refute has_element?(view, ".ts-suggest")
  end

  test "a bib-like name with no existing .bib offers a .bib chip plus the majority type",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    view |> element("#create-main-file-button") |> render_click()
    view |> form("#new-file-form", %{path: "refs"}) |> render_change()

    assert has_element?(view, ".ts-suggest__chip", "refs.bib")
    assert has_element?(view, ".ts-suggest__chip", "refs.typ")
  end

  test "creating from the typed name resolves the smart extension and opens the file",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    view |> element("#create-main-file-button") |> render_click()
    view |> form("#new-file-form", %{path: "appendix"}) |> render_submit()

    assert path_exists?(user, project, "appendix.typ")
  end

  test "the default extension suggestion is a clickable button that creates the file",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    view |> element("#create-main-file-button") |> render_click()
    view |> form("#new-file-form", %{path: "conclusion"}) |> render_change()

    # The hint pill is a real button wired to create the resolved file.
    assert view |> element("button.ts-exthint[phx-value-path='conclusion.typ']") |> has_element?()
    view |> element("button.ts-exthint") |> render_click()

    assert path_exists?(user, project, "conclusion.typ")
  end

  test "clicking a bib suggestion chip creates that file",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    view |> element("#create-main-file-button") |> render_click()
    view |> form("#new-file-form", %{path: "refs"}) |> render_change()
    view |> element(".ts-suggest__chip[phx-value-path='refs.bib']") |> render_click()

    assert path_exists?(user, project, "refs.bib")
  end

  test "creating a duplicate path is rejected and keeps the draft open",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    view |> element("#create-main-file-button") |> render_click()
    html = view |> form("#new-file-form", %{path: "main.typ"}) |> render_submit()

    assert html =~ "already exists"
    assert has_element?(view, "#new-file-draft")
    # No duplicate row was inserted.
    scope = Typster.Accounts.Scope.for_user(user)
    tree = Typster.Files.get_file_tree(scope, project.id)
    assert Enum.count(tree, &(&1.path == "main.typ")) == 1
  end

  test "pinning a file moves it into the Pinned section", %{
    conn: conn,
    user: user,
    project: project
  } do
    file = file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    refute has_element?(view, ".ts-side__head--sub")

    view
    |> element("button[phx-click='toggle_pin'][phx-value-id='#{file.id}']")
    |> render_click()

    assert has_element?(view, ".ts-side__head--sub", "Pinned")
    assert has_element?(view, ".ts-tree__pin-ind")

    scope = Typster.Accounts.Scope.for_user(user)
    assert Typster.Files.get_file!(scope, file.id).pinned
  end

  test "deleting a file removes it from the tree", %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    other = file_fixture(project, user, %{path: "notes.md"})
    view = open_editor(conn, project)

    assert has_element?(view, "[phx-value-file-id='#{other.id}']")

    view
    |> element("button[phx-click='delete_file'][phx-value-id='#{other.id}']")
    |> render_click()

    refute path_exists?(user, project, "notes.md")
    assert path_exists?(user, project, "main.typ")
  end

  test "opening files adds tabs and closing a tab activates a neighbor",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    other = file_fixture(project, user, %{path: "sections/intro.typ"})
    view = open_editor(conn, project)

    # main.typ opens as the initial tab; open the second file.
    view
    |> element("[phx-click='select_file'][phx-value-file-id='#{other.id}']")
    |> render_click()

    assert view |> element(".ts-tab.is-active .ts-tab__label") |> render() =~ "intro.typ"

    # Two tabs now open.
    assert view |> render() |> then(&(Regex.scan(~r/ts-tab__label/, &1) |> length())) == 2

    # Close the active tab → falls back to the remaining one.
    view |> element(".ts-tab.is-active .ts-tab__close") |> render_click()
    assert view |> element(".ts-tab.is-active .ts-tab__label") |> render() =~ "main.typ"
  end

  test "new file is seeded into the folder of the active file",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "sections/intro.typ"})
    view = open_editor(conn, project)

    # sections/intro.typ is the initial file, so its folder is active.
    view |> element("#create-main-file-button") |> render_click()

    # The folder is shown as a static prefix; you type only the filename.
    assert has_element?(view, ".ts-draft__dir", "sections/")
    view |> form("#new-file-form", %{path: "results"}) |> render_submit()
    assert path_exists?(user, project, "sections/results.typ")
  end

  test "a failed compile shows the error count in the preview status pill",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    render_hook(view, "preview_error", %{
      "message" => "error: unknown variable: x",
      "errors" => 2,
      "warnings" => 1
    })

    assert has_element?(view, ".ts-pill--error", "2 errors")
  end

  test "a file row carries a badge with its compile error count",
       %{conn: conn, user: user, project: project} do
    main = file_fixture(project, user, %{path: "main.typ"})
    intro = file_fixture(project, user, %{path: "sections/intro.typ"})
    view = open_editor(conn, project)

    refute has_element?(view, ".ts-tree__badge")

    render_hook(view, "preview_error", %{
      "message" => "expected comma",
      "errors" => 3,
      "warnings" => 1,
      "diagnostics" => [
        %{
          "severity" => "error",
          "message" => "a",
          "location" => %{"file" => "/sections/intro.typ"}
        },
        %{
          "severity" => "error",
          "message" => "b",
          "location" => %{"file" => "sections/intro.typ"}
        },
        %{"severity" => "warning", "message" => "c", "location" => %{"file" => "/main.typ"}}
      ]
    })

    assert has_element?(view, "#select-file-#{intro.id} .ts-tree__badge", "2")
    refute has_element?(view, "#select-file-#{main.id} .ts-tree__badge")

    render_hook(view, "update_preview", %{"ms" => 12, "pages" => 1})
    refute has_element?(view, ".ts-tree__badge")
  end

  test "the sidebar folds uploaded assets into a virtual assets folder",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    image = asset_fixture(project, user)
    view = open_editor(conn, project)

    assert has_element?(view, "#assets-folder[aria-expanded=true]", "assets")
    assert has_element?(view, "#asset-tree [id$=\"asset-entry-#{image.id}\"]")
    assert has_element?(view, "#sidebar-find-file", "Find file")
    assert has_element?(view, ".ts-side__outline .ts-side__head", "main.typ")
    assert has_element?(view, "#editor-sidebar[phx-drop-target]")
    assert has_element?(view, ".ts-side__foot #sidebar-upload", "Upload file")
    refute has_element?(view, "#upload-asset-button")

    view |> element("#assets-folder") |> render_click()
    assert has_element?(view, "#assets-folder[aria-expanded=false]")
    refute has_element?(view, "#asset-tree")

    view |> element("#assets-folder") |> render_click()
    assert has_element?(view, "#asset-tree [id$=\"asset-entry-#{image.id}\"]")
  end

  test "the compile drawer lists diagnostics and toggles from the status bar",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    refute has_element?(view, ".ts-drawer")

    render_hook(view, "preview_error", %{
      "message" => "expected comma",
      "errors" => 1,
      "warnings" => 0,
      "diagnostics" => [
        %{
          "severity" => "error",
          "message" => "expected comma",
          "location" => %{"file" => "main.typ", "line" => 15, "col" => 23}
        }
      ]
    })

    assert has_element?(view, ".ts-statusbar__btn.is-error", "1 error")

    view |> element(".ts-statusbar__btn") |> render_click()
    assert has_element?(view, ".ts-drawer")

    view |> element(".ts-drawer__tab", "Problems") |> render_click()
    assert has_element?(view, ".ts-problem__loc", "15 : 23")
    assert has_element?(view, ".ts-problem__msg", "expected comma")
  end

  test "a successful compile records a log entry in the drawer",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    render_hook(view, "update_preview", %{"ms" => 47, "pages" => 3})
    view |> element(".ts-statusbar__btn") |> render_click()

    assert has_element?(view, ".ts-log__row--ok", "compiled")
  end

  test "the merged top bar breadcrumb shows the active file's folder path (no filename)",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "sections/intro.typ"})
    view = open_editor(conn, project)

    # v3.1 merged top bar: project + folder segments, the last folder is active,
    # and the filename is no longer in the crumb — it lives on the tab.
    assert has_element?(view, ".ts-tb__crumb .ts-tb__seg", "sections")
    assert has_element?(view, ".ts-tb__crumb .ts-tb__seg.is-active", "sections")
    refute has_element?(view, ".ts-tb__crumb .ts-tb__seg", "intro.typ")
    assert has_element?(view, ".ts-tab", "intro.typ")
  end

  test "the merged top bar renders the project switcher, omnibox and account menu",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    assert has_element?(view, ".ts-tb__proj", project.name)
    assert has_element?(view, ".ts-tb__omni")
    assert has_element?(view, ".ts-tb__avatar")
    # The account dropdown is in the DOM (hidden until toggled) with a logout row.
    assert has_element?(view, "#tb-account-menu .ts-tb__menu-item.is-danger")
  end

  test "the top bar compile button reflects the latest successful compile",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    render_hook(view, "update_preview", %{"ms" => 47, "pages" => 1})

    assert has_element?(view, ".ts-tb__compile.is-success", "47")
    refute has_element?(view, ".ts-tb__compile.is-error")
  end

  test "the top bar compile button reflects a failed compile",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    render_hook(view, "preview_error", %{"message" => "boom", "errors" => 2})

    assert has_element?(view, ".ts-tb__compile.is-error", "2")
  end

  test "the status bar builds a compile sparkline from compile history",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    refute has_element?(view, ".ts-spark")

    render_hook(view, "update_preview", %{"ms" => 47, "pages" => 1})
    render_hook(view, "update_preview", %{"ms" => 60, "pages" => 1})

    assert has_element?(view, ".ts-spark .ts-spark__bar")
  end

  test "a failed compile records an error bar in the sparkline",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    render_hook(view, "preview_error", %{"message" => "boom", "errors" => 1})

    assert has_element?(view, ".ts-spark .ts-spark__bar.is-err")
  end

  test "outline numbers headings and shows a section count",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    render_hook(view, "outline_parsed", %{
      "items" => [
        %{"level" => 1, "text" => "Quarterly Report", "line" => 1},
        %{"level" => 2, "text" => "Summary", "line" => 3},
        %{"level" => 2, "text" => "Key results", "line" => 7},
        %{"level" => 3, "text" => "Uptime", "line" => 9}
      ]
    })

    # level-1 title stays unnumbered; level 2 -> 1, 2; level 3 -> 2.1
    assert has_element?(view, ".ts-outline__num", "2.1")
    assert has_element?(view, ".ts-side__count", "4 sections")
  end

  test "the new-folder button creates a folder seeded with a starter file",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    view |> element("#create-folder-button") |> render_click()
    assert has_element?(view, "#new-file-draft #new-file-form")
    view |> form("#new-file-form", %{path: "chapters"}) |> render_submit()

    assert path_exists?(user, project, "chapters/untitled.typ")
  end

  test "dropping a source file onto the editor creates it from the dropped content",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    input =
      file_input(view, "#dropped-upload-form", :dropped, [
        %{name: "dropped.typ", content: "= Dropped in", type: "text/plain"}
      ])

    render_upload(input, "dropped.typ")

    scope = Typster.Accounts.Scope.for_user(user)

    created =
      Enum.find(Typster.Files.get_file_tree(scope, project.id), &(&1.path == "dropped.typ"))

    assert created.content == "= Dropped in"
  end

  test "using a template stages its content into the file you create",
       %{conn: conn, user: user, project: project} do
    scope = Typster.Accounts.Scope.for_user(user)

    {:ok, tpl} =
      Typster.Templates.create_template(scope, %{name: "ieee.typ", content: "= From tpl"})

    file_fixture(project, user, %{path: "main.typ"})
    view = open_editor(conn, project)

    view
    |> element("button[phx-click='use_template'][phx-value-id='#{tpl.id}']")
    |> render_click()

    assert has_element?(view, "#new-file-draft")
    view |> form("#new-file-form", %{path: "paper.typ"}) |> render_submit()

    created = Enum.find(Typster.Files.get_file_tree(scope, project.id), &(&1.path == "paper.typ"))
    assert created.content == "= From tpl"
  end

  test "file rows render colored type chips by extension",
       %{conn: conn, user: user, project: project} do
    file_fixture(project, user, %{path: "main.typ"})
    file_fixture(project, user, %{path: "refs.bib"})
    view = open_editor(conn, project)

    assert has_element?(view, ".ts-filechip--typ")
    assert has_element?(view, ".ts-filechip--bib")
  end

  test "file rows are draggable and folder rows are drop targets",
       %{conn: conn, user: user, project: project} do
    file = file_fixture(project, user, %{path: "chapters/intro.typ"})
    view = open_editor(conn, project)

    assert has_element?(view, "li[draggable='true'][data-dnd-file='#{file.id}']")
    assert has_element?(view, "li[data-dnd-dir='chapters']")
  end

  test "dragging a file onto a folder moves it under that folder",
       %{conn: conn, user: user, project: project} do
    file = file_fixture(project, user, %{path: "main.typ"})
    file_fixture(project, user, %{path: "chapters/intro.typ"})
    view = open_editor(conn, project)

    render_hook(view, "move_file", %{"id" => file.id, "dir" => "chapters"})

    assert path_exists?(user, project, "chapters/main.typ")
    refute path_exists?(user, project, "main.typ")
  end

  test "dropping a nested file onto the empty tree moves it to the project root",
       %{conn: conn, user: user, project: project} do
    file = file_fixture(project, user, %{path: "chapters/intro.typ"})
    view = open_editor(conn, project)

    render_hook(view, "move_file", %{"id" => file.id, "dir" => ""})

    assert path_exists?(user, project, "intro.typ")
    refute path_exists?(user, project, "chapters/intro.typ")
  end

  test "moving onto a folder that already holds the same name is rejected",
       %{conn: conn, user: user, project: project} do
    file = file_fixture(project, user, %{path: "main.typ"})
    file_fixture(project, user, %{path: "chapters/main.typ"})
    view = open_editor(conn, project)

    render_hook(view, "move_file", %{"id" => file.id, "dir" => "chapters"})

    assert path_exists?(user, project, "main.typ")
    assert path_exists?(user, project, "chapters/main.typ")
  end

  defp path_exists?(user, project, path) do
    scope = Typster.Accounts.Scope.for_user(user)
    Enum.any?(Typster.Files.get_file_tree(scope, project.id), &(&1.path == path))
  end

  describe "share modal — Pro write-scope card" do
    test "is clickable, previews the upsell, but never changes the link scope",
         %{conn: conn, user: user, project: project} do
      view = open_editor(conn, project)

      view |> element(".ts-tb__share") |> render_click()
      assert has_element?(view, ".perm-card.tone-write")
      # Resting state: not active, no upgrade banner yet.
      refute has_element?(view, ".perm-card.tone-write.active")

      # Clicking the Pro card activates it and reveals the upsell (not usable)…
      view |> element("[phx-click='share_scope'][phx-value-scope='write']") |> render_click()
      assert has_element?(view, ".perm-card.tone-write.active")
      assert has_element?(view, ".perm-card.tone-write .upgrade-banner")

      # …but the real link scope is unchanged (still a free scope, never :write).
      scope = Typster.Accounts.Scope.for_user(user)
      link = Typster.Sharing.get_or_create_link(scope, project.id)
      assert link.scope in [:read, :output, :full]

      # Choosing a real scope clears the preview.
      view |> element("[phx-click='share_scope'][phx-value-scope='output']") |> render_click()
      refute has_element?(view, ".perm-card.tone-write.active")
    end
  end

  describe "collaborator access" do
    setup %{user: owner, project: project} do
      owner_scope = Typster.Accounts.Scope.for_user(owner)

      {:ok, invite} =
        Typster.Sharing.invite_collaborator(owner_scope, project.id, "c@x.com", :editor)

      collaborator = Typster.AccountsFixtures.user_fixture(%{email: "c@x.com"})

      {:ok, _} =
        Typster.Sharing.accept_invite(Typster.Accounts.Scope.for_user(collaborator), invite.id)

      collab_conn = log_in_user(build_conn(), collaborator)
      %{collab_conn: collab_conn}
    end

    test "an accepted collaborator can open the owner's editor",
         %{collab_conn: conn, user: user, project: project} do
      file_fixture(project, user, %{path: "main.typ"})
      view = open_editor(conn, project)

      assert has_element?(view, ".ts-tb__proj", project.name)
      assert has_element?(view, "#create-main-file-button")
    end

    test "the Share button shows for all but is inactive for collaborators",
         %{conn: owner_conn, collab_conn: collab_conn, project: project} do
      owner_view = open_editor(owner_conn, project)
      collab_view = open_editor(collab_conn, project)

      # Owner: an active Share button.
      assert has_element?(owner_view, ".ts-tb__share")
      refute has_element?(owner_view, ".ts-tb__share.is-inactive")

      # Collaborator: the button is present (consistent top bar) but inert.
      assert has_element?(collab_view, ".ts-tb__share.is-inactive")
      assert has_element?(collab_view, ".ts-tb__share[disabled]")
    end

    test "a non-owner's share mutation is a no-op server-side",
         %{collab_conn: conn, user: owner, project: project} do
      view = open_editor(conn, project)
      owner_scope = Typster.Accounts.Scope.for_user(owner)
      before = Typster.Sharing.list_collaborators(owner_scope, project.id)

      # A crafted event the disabled button can't send must no-op, not invite.
      render_hook(view, "share_invite", %{
        "invite" => %{"email" => "intruder@example.com", "role" => "editor"}
      })

      assert Typster.Sharing.list_collaborators(owner_scope, project.id) == before
    end
  end

  describe "fonts in the assets panel" do
    test "a font row shows the family names the preview reported", %{
      conn: conn,
      user: user,
      project: project
    } do
      font = asset_fixture(project, user, %{filename: "Brand.ttf", content_type: "font/ttf"})
      view = open_editor(conn, project)

      # Before the worker reports anything the row falls back to the size.
      assert has_element?(view, "[id$='asset-entry-#{font.id}'] .ts-filechip--font")
      assert has_element?(view, "[id$='asset-entry-#{font.id}'] .ts-tree__pill", "128 B")

      render_hook(view, "fonts_registered", %{
        "fonts" => [
          %{
            "reference_path" => "assets/Brand.ttf",
            "families" => ["Brand Sans", "Brand Sans Display"]
          }
        ]
      })

      assert has_element?(
               view,
               "[id$='asset-entry-#{font.id}'] .ts-tree__pill--font",
               "Brand Sans, Brand Sans Display"
             )

      assert has_element?(
               view,
               "[id$='asset-entry-#{font.id}'] .ts-tree__pill[title*='font: \"Brand Sans\"']"
             )
    end

    test "asset rows carry the snippet dragged into the editor", %{
      conn: conn,
      user: user,
      project: project
    } do
      image = asset_fixture(project, user)
      font = asset_fixture(project, user, %{filename: "Brand.ttf", content_type: "font/ttf"})
      woff = asset_fixture(project, user, %{filename: "web.woff2", content_type: "font/woff2"})
      view = open_editor(conn, project)

      assert has_element?(
               view,
               ~s|#asset-tree[phx-hook="InsertDrag"] [id$="asset-entry-#{image.id}"][draggable="true"][data-insert='#image("assets/logo.png")']|
             )

      # A font has nothing to insert until the preview reports its family.
      refute has_element?(view, "[id$='asset-entry-#{font.id}'][data-insert]")
      refute has_element?(view, "[id$='asset-entry-#{woff.id}'][data-insert]")

      render_hook(view, "fonts_registered", %{
        "fonts" => [%{"reference_path" => "assets/Brand.ttf", "families" => ["Brand Sans"]}]
      })

      assert has_element?(
               view,
               ~s|[id$="asset-entry-#{font.id}"][draggable="true"][data-insert='#set text(font: "Brand Sans")']|
             )
    end

    test "file rows insert a path relative to the open file, never an id", %{
      conn: conn,
      user: user,
      project: project
    } do
      main = file_fixture(project, user, %{path: "main.typ"})
      intro = file_fixture(project, user, %{path: "chapters/intro.typ", content: "= Intro"})
      asset_fixture(project, user)
      view = open_editor(conn, project)

      view
      |> element("[phx-click='select_file'][phx-value-file-id='#{intro.id}']")
      |> render_click()

      assert has_element?(
               view,
               ~s|#file-tree-main #select-file-#{main.id}[draggable="true"][data-insert='#include "../main.typ"']|
             )

      # The open file can't include itself.
      refute has_element?(view, "#select-file-#{intro.id}[data-insert]")
      assert has_element?(view, ~s|#asset-tree [data-insert='#image("../assets/logo.png")']|)
    end

    test "a WOFF upload is flagged as unreadable by Typst", %{
      conn: conn,
      user: user,
      project: project
    } do
      woff = asset_fixture(project, user, %{filename: "web.woff2", content_type: "font/woff2"})
      view = open_editor(conn, project)

      assert has_element?(view, "[id$='asset-entry-#{woff.id}'] .ts-tree__pill", "needs TTF/OTF")
    end

    test "dropping a font uploads it and pushes the new asset list to the editor", %{
      conn: conn,
      user: user,
      project: project
    } do
      file_fixture(project, user, %{path: "main.typ"})
      view = open_editor(conn, project)
      bytes = File.read!("assets/e2e/fixtures/NotoSansLycian-Regular.ttf")

      input =
        file_input(view, "#dropped-upload-form", :dropped, [
          %{name: "Brand.otf", content: bytes, type: "font/otf"}
        ])

      render_upload(input, "Brand.otf")

      assert has_element?(view, "[id*='asset-entry'] .ts-filechip--font")
      assert render(view) =~ "Brand.otf"

      assert_push_event(view, "assets_updated", %{
        assets: [%{kind: "font", reference_path: "assets/Brand.otf", url: url}]
      })

      assert url =~ ~r"^/projects/#{project.id}/assets/[0-9a-f-]+/raw$"
    end

    test "a font dropped on the template zone becomes an asset, not a template", %{
      conn: conn,
      user: user,
      project: project
    } do
      file_fixture(project, user, %{path: "main.typ"})
      view = open_editor(conn, project)
      bytes = File.read!("assets/e2e/fixtures/NotoSansLycian-Regular.ttf")

      input =
        file_input(view, "#template-upload-form", :template, [
          %{name: "Espruar.otf", content: bytes, type: "font/otf"}
        ])

      render_upload(input, "Espruar.otf")

      assert has_element?(view, "[id*='asset-entry'] .ts-filechip--font")
      assert render(view) =~ "Espruar.otf"
      assert Typster.Templates.list_templates(Typster.Accounts.Scope.for_user(user)) == []
      assert_push_event(view, "assets_updated", %{assets: [%{kind: "font"}]})
    end

    test "binary bytes under a text extension are rejected on the template zone", %{
      conn: conn,
      user: user,
      project: project
    } do
      file_fixture(project, user, %{path: "main.typ"})
      view = open_editor(conn, project)

      input =
        file_input(view, "#template-upload-form", :template, [
          %{
            name: "not-text.typ",
            content: <<0, 1, 2, 255, 254>>,
            type: "application/octet-stream"
          }
        ])

      render_upload(input, "not-text.typ")

      assert Typster.Templates.list_templates(Typster.Accounts.Scope.for_user(user)) == []
      assert render(view) =~ "Unsupported file format."
    end

    test "the upload icon and template label point at their file inputs", %{
      conn: conn,
      project: project
    } do
      view = open_editor(conn, project)
      doc = view |> render() |> LazyHTML.from_fragment()
      input_ids = doc |> LazyHTML.query("input[type=file]") |> LazyHTML.attribute("id")
      label_fors = doc |> LazyHTML.query("label[for]") |> LazyHTML.attribute("for")

      assert label_fors != []
      assert Enum.all?(label_fors, &(&1 in input_ids))
    end

    test "the Upload asset button path adds the font and pushes the asset list", %{
      conn: conn,
      user: user,
      project: project
    } do
      file_fixture(project, user, %{path: "main.typ"})
      view = open_editor(conn, project)
      bytes = File.read!("assets/e2e/fixtures/NotoSansLycian-Regular.ttf")

      input =
        file_input(view, "#asset-upload-form", :asset, [
          %{name: "Button.ttf", content: bytes, type: "font/ttf"}
        ])

      render_upload(input, "Button.ttf")
      view |> form("#asset-upload-form") |> render_submit()

      row = "[id*='asset-entry']"
      assert has_element?(view, "#{row}.is-asset .ts-filechip--font")
      refute has_element?(view, "#{row}.is-disabled")
      assert render(view) =~ "Button.ttf"
      assert_push_event(view, "assets_updated", %{assets: [%{kind: "font"}]})
    end

    test "malformed font reports are ignored", %{conn: conn, user: user, project: project} do
      font = asset_fixture(project, user, %{filename: "Brand.ttf"})
      view = open_editor(conn, project)

      render_hook(view, "fonts_registered", %{"fonts" => "nope"})

      render_hook(view, "fonts_registered", %{
        "fonts" => [%{"reference_path" => 1, "families" => [2]}]
      })

      assert has_element?(view, "[id$='asset-entry-#{font.id}'] .ts-tree__pill", "128 B")
    end
  end

  describe "word count in the status bar" do
    test "shows the compiled document's word count once the preview reports it", %{
      conn: conn,
      user: user,
      project: project
    } do
      file_fixture(project, user, %{path: "main.typ"})
      view = open_editor(conn, project)

      refute has_element?(view, "#status-words")

      render_hook(view, "update_preview", %{"ms" => 42, "pages" => 1, "words" => 1, "chars" => 5})
      assert has_element?(view, "#status-words", "1 word")

      render_hook(view, "update_preview", %{
        "ms" => 40,
        "pages" => 2,
        "words" => 1234,
        "chars" => 6789
      })

      assert has_element?(view, "#status-words", "1234 words")
      assert has_element?(view, "#status-words[title='6789 characters, not counting spaces']")
    end

    test "ignores malformed counters from the client", %{conn: conn, user: user, project: project} do
      file_fixture(project, user, %{path: "main.typ"})
      view = open_editor(conn, project)

      render_hook(view, "update_preview", %{
        "ms" => 42,
        "pages" => 1,
        "words" => "lots",
        "chars" => -1
      })

      refute has_element?(view, "#status-words")
    end
  end
end
