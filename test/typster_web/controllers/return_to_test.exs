defmodule TypsterWeb.ReturnToTest do
  use TypsterWeb.ConnCase, async: true

  import Typster.AccountsFixtures

  alias TypsterWeb.UserAuth

  @share_path "/p/paper?key=abcd-efgh&fork=1"

  describe "safe_return_to/1" do
    test "accepts local paths, with or without a query" do
      assert UserAuth.safe_return_to("/p/paper") == "/p/paper"
      assert UserAuth.safe_return_to(@share_path) == @share_path
    end

    test "rejects absolute, protocol-relative and smuggled targets" do
      for bad <- [
            "https://evil.example/p/x",
            "//evil.example/p/x",
            "/\\evil.example",
            "/\t/evil.example",
            "javascript:alert(1)",
            "evil.example",
            "",
            nil,
            "/" <> String.duplicate("a", 2048)
          ] do
        assert UserAuth.safe_return_to(bad) == nil, "accepted #{inspect(bad)}"
      end
    end
  end

  describe "?return_to= on the auth pages" do
    test "a local path is stored and honoured after password login", %{conn: conn} do
      user = set_password(user_fixture())

      conn = get(conn, ~p"/users/log-in?#{[return_to: @share_path]}")
      assert get_session(conn, :user_return_to) == @share_path

      conn =
        post(conn, ~p"/users/log-in", %{
          "user" => %{"email" => user.email, "password" => valid_user_password()}
        })

      assert redirected_to(conn) == @share_path
    end

    test "the registration page stores it too (for the magic-link sign-in)", %{conn: conn} do
      conn = get(conn, ~p"/users/register?#{[return_to: @share_path]}")
      assert get_session(conn, :user_return_to) == @share_path
    end

    test "external and protocol-relative targets are ignored", %{conn: conn} do
      for bad <- ["https://evil.example/", "//evil.example/"] do
        conn = get(conn, ~p"/users/log-in?#{[return_to: bad]}")
        assert get_session(conn, :user_return_to) == nil
      end
    end

    test "other pages do not store it", %{conn: conn} do
      conn = get(conn, ~p"/?#{[return_to: "/projects"]}")
      assert get_session(conn, :user_return_to) == nil
    end
  end
end
