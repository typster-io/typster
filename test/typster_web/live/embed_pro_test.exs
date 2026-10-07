defmodule TypsterWeb.EmbedProTest do
  @moduledoc """
  Grant side of the embed Pro capabilities — the counterpart to
  `embed_policy_test.exs`. Tagged `:pro`, so it runs **only** when the closed
  `vendor/pro` submodule is compiled in (the CI Pro-edition leg opts in with
  `mix test --include pro`); the open-core suite excludes it.

  With `Typster.Pro.Features` + `Typster.Pro.Embed` present, a `:pro`-plan owner
  unlocks: the editable sandbox (`:share_embed_sandbox`), the unbranded footer
  (`:share_embed_unbranded`), and the per-embed smart CTA (`:share_embed_smart_cta`).
  """
  use TypsterWeb.ConnCase, async: true

  @moduletag :pro

  import Phoenix.LiveViewTest
  import Typster.AccountsFixtures, only: [pro_user_fixture: 0]
  import Typster.ProjectsFixtures, only: [project_fixture: 1, file_fixture: 3]

  alias Typster.Accounts.Scope
  alias Typster.Sharing

  setup %{conn: conn} do
    owner = pro_user_fixture()
    scope = Scope.for_user(owner)
    project = project_fixture(owner)
    file_fixture(project, owner, %{path: "main.typ", content: "= Hi"})
    link = Sharing.get_or_create_link(scope, project.id)

    %{conn: conn, link: link, project: project}
  end

  test "?editable=1 turns the embed into a writable sandbox", %{conn: conn, link: link} do
    {:ok, view, _html} = live(conn, ~p"/embed/#{link.token}?#{[editable: "1"]}")

    assert has_element?(view, ~s|#editor-container[data-readonly="false"]|)
    assert has_element?(view, ".ro-pill--edit")
  end

  test "the sandbox is opt-in — a Pro owner's plain embed stays read-only", %{
    conn: conn,
    link: link
  } do
    {:ok, view, _html} = live(conn, ~p"/embed/#{link.token}")

    assert has_element?(view, ~s|#editor-container[data-readonly="true"]|)
    refute has_element?(view, ".ro-pill--edit")
  end

  test "the footer can be unbranded", %{conn: conn, link: link} do
    {:ok, view, _html} = live(conn, ~p"/embed/#{link.token}?#{[unbranded: "1"]}")

    refute has_element?(view, ".embed-foot .powered")
  end

  test "?cta=signup swaps the footer CTA for the sign-up funnel", %{
    conn: conn,
    link: link,
    project: project
  } do
    {:ok, view, _html} = live(conn, ~p"/embed/#{link.token}?#{[cta: "signup"]}")

    assert has_element?(view, ~s|a.embed-foot__cta[href="/users/register"]|)

    refute has_element?(
             view,
             ~s|a.embed-foot__cta[href="/p/#{Sharing.slug(project)}?key=#{link.token}"]|
           )
  end

  test "?cta=none removes the footer CTA entirely", %{conn: conn, link: link} do
    {:ok, view, _html} = live(conn, ~p"/embed/#{link.token}?#{[cta: "none"]}")

    refute has_element?(view, ".embed-foot__cta")
  end

  describe "Pro embed policy (via Typster.Embed.impl/0)" do
    # Resolve the Pro module through the host's runtime dispatch rather than a
    # literal `Typster.Pro.Embed` reference, so this file compiles warning-free
    # in the open-core build where that module doesn't exist (the test itself is
    # `:pro`-tagged, so it only *runs* when the Pro code is present).
    @pro %{plan: :pro}

    test "an entitled owner maps known CTA modes and falls back to :open" do
      impl = Typster.Embed.impl()
      assert impl == Typster.Pro.Embed
      assert impl.cta(@pro, %{"cta" => "signup"}) == %{mode: :signup}
      assert impl.cta(@pro, %{"cta" => "fork"}) == %{mode: :fork}
      assert impl.cta(@pro, %{"cta" => "none"}) == %{mode: :none}
      assert impl.cta(@pro, %{"cta" => "open"}) == %{mode: :open}
      assert impl.cta(@pro, %{"cta" => "bogus"}) == %{mode: :open}
      assert impl.cta(@pro, %{}) == %{mode: :open}
    end

    test "policy/2 owns editable + unbranded + cta, gated on the owner" do
      impl = Typster.Embed.impl()

      assert impl.policy(@pro, %{"editable" => "1", "unbranded" => "1", "cta" => "signup"}) ==
               %{editable: true, unbranded: true, cta: %{mode: :signup}}

      # A free/anonymous owner is denied every capability by the Pro module too.
      assert impl.policy(%{plan: :free}, %{"editable" => "1", "cta" => "fork"}) ==
               %{editable: false, unbranded: false, cta: %{mode: :open}}

      assert impl.policy(nil, %{"editable" => "1"}) ==
               %{editable: false, unbranded: false, cta: %{mode: :open}}
    end
  end
end
