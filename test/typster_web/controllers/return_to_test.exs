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

    test "other pages behind the same plug do not store it", %{conn: conn} do
      # Both routes pipe through `store_return_to_param`; only the exact
      # log-in and register paths may act on the param.
      for path <- [
            ~p"/users/log-in/some-token?#{[return_to: "/projects"]}",
            ~p"/p/paper?#{[key: "nope", return_to: "/projects"]}"
          ] do
        conn = get(conn, path)
        assert get_session(conn, :user_return_to) == nil, "stored on #{path}"
      end
    end

    test "a plain revisit of the auth pages drops a stored share target", %{conn: conn} do
      user = set_password(user_fixture())

      # Visitor A starts "Sign in to copy" and walks away…
      conn = get(conn, ~p"/users/log-in?#{[return_to: @share_path]}")
      # …visitor B opens the log-in page on the same browser and signs in.
      conn = get(conn, ~p"/users/log-in")
      assert get_session(conn, :user_return_to) == nil

      conn =
        post(conn, ~p"/users/log-in", %{
          "user" => %{"email" => user.email, "password" => valid_user_password()}
        })

      assert redirected_to(conn) == ~p"/"
    end

    test "a protected page's return target survives the log-in page", %{conn: conn} do
      conn = get(conn, ~p"/projects")
      assert redirected_to(conn) == ~p"/users/log-in"

      conn = get(conn, ~p"/users/log-in")
      assert get_session(conn, :user_return_to) == ~p"/projects"
    end

    test "log-in re-validates the stored target", %{conn: conn} do
      user = set_password(user_fixture())

      conn =
        conn
        |> init_test_session(user_return_to: "//evil.example/")
        |> post(~p"/users/log-in", %{
          "user" => %{"email" => user.email, "password" => valid_user_password()}
        })

      assert redirected_to(conn) == ~p"/"
    end

    test "the magic-link sign-in after registration honours it", %{conn: conn} do
      conn = get(conn, ~p"/users/register?#{[return_to: @share_path]}")

      user = unconfirmed_user_fixture()
      {token, _hashed} = generate_user_magic_link_token(user)

      conn =
        post(conn, ~p"/users/log-in", %{
          "user" => %{"token" => token},
          "_action" => "confirmed"
        })

      assert redirected_to(conn) == @share_path
    end
  end
end
