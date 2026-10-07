defmodule TypsterWeb.FileTreeTest do
  use ExUnit.Case, async: true

  alias Typster.Assets.Asset
  alias TypsterWeb.FileTree

  defp insert(filename, families \\ %{}, current_path \\ "main.typ") do
    asset = %Asset{filename: filename}
    FileTree.asset_insert(asset, Typster.Assets.kind(asset), families, current_path)
  end

  describe "insert_snippet/2" do
    test "paths are relative to the open file's directory" do
      assert FileTree.insert_snippet("figs/plot.png", "main.typ") == ~s|#image("figs/plot.png")|

      assert FileTree.insert_snippet("figs/plot.png", "chapters/intro.typ") ==
               ~s|#image("../figs/plot.png")|

      assert FileTree.insert_snippet("chapters/b.typ", "chapters/a.typ") == ~s|#include "b.typ"|
      assert FileTree.insert_snippet("refs.bib", nil) == ~s|#bibliography("refs.bib")|
    end

    test "each file type gets the matching Typst call" do
      assert FileTree.insert_snippet("ch.typ") == ~s|#include "ch.typ"|
      assert FileTree.insert_snippet("Plot.SVG") == ~s|#image("Plot.SVG")|
      assert FileTree.insert_snippet("paper.pdf") == ~s|#image("paper.pdf")|
      assert FileTree.insert_snippet("table.csv") == ~s|#csv("table.csv")|
      assert FileTree.insert_snippet("data.json") == ~s|#json("data.json")|
      assert FileTree.insert_snippet("conf.yml") == ~s|#yaml("conf.yml")|
      assert FileTree.insert_snippet("conf.toml") == ~s|#toml("conf.toml")|
      assert FileTree.insert_snippet("feed.xml") == ~s|#xml("feed.xml")|
      assert FileTree.insert_snippet("notes.txt") == ~s|#read("notes.txt")|
    end

    test "quotes and backslashes are escaped inside the Typst string" do
      assert FileTree.insert_snippet(~S|a"b\c.png|) == ~S|#image("a\"b\\c.png")|
    end
  end

  describe "asset_insert/4" do
    test "an asset is referenced under assets/, relative to the open file" do
      assert insert("logo.png") == ~s|#image("assets/logo.png")|
      assert insert("logo.png", %{}, "chapters/intro.typ") == ~s|#image("../assets/logo.png")|
      assert insert("refs.bib") == ~s|#bibliography("assets/refs.bib")|
    end

    test "a font inserts a set rule once its family is known" do
      assert insert("Brand.ttf") == nil

      assert insert("Brand.ttf", %{"assets/Brand.ttf" => ["Brand Sans", "Brand Display"]}) ==
               ~s|#set text(font: "Brand Sans")|
    end

    test "a web font has nothing to insert" do
      assert insert("web.woff2") == nil
    end
  end

  describe "file_nodes/3" do
    test "rows carry a relative snippet, except the open file itself" do
      files = [
        %{id: 1, path: "chapters/intro.typ"},
        %{id: 2, path: "chapters/outro.typ"},
        %{id: 3, path: "main.typ"}
      ]

      inserts =
        files
        |> FileTree.file_nodes(:flat, "chapters/intro.typ")
        |> Map.new(&{&1.path, &1.insert})

      assert inserts == %{
               "chapters/intro.typ" => nil,
               "chapters/outro.typ" => ~s|#include "outro.typ"|,
               "main.typ" => ~s|#include "../main.typ"|
             }
    end
  end
end
