defmodule TypsterWeb.EmbedPolicyTest do
  @moduledoc """
  Edition-independent deny side of the embed Pro capabilities (`Typster.Embed`).

  A free or anonymous owner is denied every Pro embed capability in **both**
  editions — the open-core `Typster.Features.Free` denies all of them, and the
  Pro `Typster.Pro.Features` denies any non-`:pro` plan — so these assertions
  hold whether or not `vendor/pro` is compiled in. The grant side (a `:pro`
  owner with the Pro code present) lives in `embed_pro_test.exs`, tagged `:pro`.
  """
  use TypsterWeb.ConnCase, async: true

  import Phoenix.LiveViewTest
  import Typster.AccountsFixtures, only: [user_fixture: 0]
  import Typster.ProjectsFixtures, only: [project_fixture: 1, file_fixture: 3]

  alias Typster.Accounts.Scope
  alias Typster.Embed
  alias Typster.Sharing

  describe "free owner embed (rendered)" do
    setup %{conn: conn} do
      owner = user_fixture()
      scope = Scope.for_user(owner)
      project = project_fixture(owner)
      file_fixture(project, owner, %{path: "main.typ", content: "= Hi"})
      %{conn: conn, link: Sharing.get_or_create_link(scope, project.id), project: project}
    end

    test "stays read-only even when ?editable=1 is requested", %{conn: conn, link: link} do
      {:ok, view, _html} = live(conn, ~p"/embed/#{link.token}?#{[editable: "1"]}")

      assert has_element?(view, ~s|#editor-container[data-readonly="true"]|)
      refute has_element?(view, ".ro-pill--edit")
    end

    test "stays branded and ignores a smart-CTA request", %{
      conn: conn,
      link: link,
      project: project
    } do
      {:ok, view, _html} = live(conn, ~p"/embed/#{link.token}?#{[cta: "signup"]}")

      # The fixed free CTA opens the public share page (keyed by the link),
      # never the editor — that URL only works for people with edit access.
      share_href = "/p/#{Sharing.slug(project)}?key=#{link.token}"

      assert has_element?(view, ".embed-foot .powered")
      assert has_element?(view, ~s|a.embed-foot__cta[href="#{share_href}"]|)
      refute has_element?(view, ~s|a.embed-foot__cta[href="/users/register"]|)
    end
  end

  describe "Typster.Embed.policy/2 (pure)" do
    test "an anonymous (nil) owner is denied every capability" do
      assert Embed.policy(nil, %{"editable" => "1", "cta" => "signup"}) ==
               %{editable: false, unbranded: false, cta: %{mode: :open}}
    end

    test "a free-plan owner is denied every capability" do
      scope = Scope.for_user(user_fixture())

      assert Embed.policy(scope, %{"editable" => "1", "cta" => "fork"}) ==
               %{editable: false, unbranded: false, cta: %{mode: :open}}
    end
  end
end
