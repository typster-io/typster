defmodule Typster.ProjectsTest do
  use Typster.DataCase, async: true

  import Typster.AccountsFixtures
  import Typster.ProjectsFixtures

  alias Typster.Accounts.Scope
  alias Typster.Projects
  alias Typster.Sharing

  describe "project scoping" do
    test "create_project/2 assigns ownership to the current scope user" do
      user = user_fixture()
      scope = Scope.for_user(user)

      {:ok, project} = Projects.create_project(scope, %{name: "Owned"})

      assert project.user_id == user.id
    end

    test "create_project/2 rejects names longer than the column" do
      scope = Scope.for_user(user_fixture())

      assert {:error, changeset} =
               Projects.create_project(scope, %{name: String.duplicate("é", 256)})

      assert %{name: [_]} = errors_on(changeset)
      assert {:ok, _} = Projects.create_project(scope, %{name: String.duplicate("é", 255)})
    end

    test "list_projects/1 only returns projects for the current scope user" do
      user = user_fixture()
      other_user = user_fixture()

      visible = project_fixture(user, %{name: "Visible"})
      _hidden = project_fixture(other_user, %{name: "Hidden"})

      assert [project] = Projects.list_projects(Scope.for_user(user))
      assert project.id == visible.id
    end

    test "get_project!/2 rejects access to another user's project" do
      user = user_fixture()
      other_user = user_fixture()
      project = project_fixture(other_user)

      assert_raise Ecto.NoResultsError, fn ->
        Projects.get_project!(Scope.for_user(user), project.id)
      end
    end
  end

  describe "collaborator access (member-aware)" do
    setup do
      owner = user_scope_fixture()
      project = project_fixture(owner)
      member = Scope.for_user(user_fixture(%{email: "guest@example.com"}))
      stranger = user_scope_fixture()
      {:ok, invite} = Sharing.invite_collaborator(owner, project.id, "guest@example.com", :editor)
      %{owner: owner, project: project, member: member, stranger: stranger, invite: invite}
    end

    test "get_editable_project!/2 allows owner + accepted collaborator, rejects others", ctx do
      %{owner: owner, project: project, member: member, stranger: stranger, invite: invite} = ctx

      assert Projects.get_editable_project!(owner, project.id).id == project.id

      # Pending invite is not yet access.
      assert_raise Ecto.NoResultsError, fn ->
        Projects.get_editable_project!(member, project.id)
      end

      {:ok, _} = Sharing.accept_invite(member, invite.id)
      assert Projects.get_editable_project!(member, project.id).id == project.id

      assert_raise Ecto.NoResultsError, fn ->
        Projects.get_editable_project!(stranger, project.id)
      end
    end

    test "owner-only get_project!/2 still rejects accepted collaborators", ctx do
      %{project: project, member: member, invite: invite} = ctx
      {:ok, _} = Sharing.accept_invite(member, invite.id)

      assert_raise Ecto.NoResultsError, fn ->
        Projects.get_project!(member, project.id)
      end
    end

    test "list_projects/1 includes projects shared as an accepted collaborator", ctx do
      %{project: project, member: member, invite: invite} = ctx

      assert Projects.list_projects(member) == []
      {:ok, _} = Sharing.accept_invite(member, invite.id)
      assert [shared] = Projects.list_projects(member)
      assert shared.id == project.id
    end

    test "owner?/2 distinguishes owner from collaborator", ctx do
      %{owner: owner, project: project, member: member, invite: invite} = ctx
      {:ok, _} = Sharing.accept_invite(member, invite.id)

      assert Projects.owner?(owner, project)
      refute Projects.owner?(member, project)
    end
  end
end
