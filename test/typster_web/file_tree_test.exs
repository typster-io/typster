defmodule TypsterWeb.FileTreeTest do
  use ExUnit.Case, async: true

  alias Typster.Assets.Asset
  alias TypsterWeb.FileTree

  defp insert(filename, families \\ %{}) do
    asset = %Asset{filename: filename}
    FileTree.asset_insert(asset, Typster.Assets.kind(asset), families)
  end

  describe "asset_insert/3" do
    test "an image becomes a root-absolute image() call" do
      assert insert("logo.png") == ~s|#image("/assets/logo.png")|
      assert insert("figs/Plot.SVG") == ~s|#image("/assets/figs/Plot.SVG")|
    end

    test "data files use the matching Typst loader" do
      assert insert("refs.bib") == ~s|#bibliography("/assets/refs.bib")|
      assert insert("table.csv") == ~s|#csv("/assets/table.csv")|
      assert insert("data.json") == ~s|#json("/assets/data.json")|
      assert insert("conf.yml") == ~s|#yaml("/assets/conf.yml")|
      assert insert("conf.toml") == ~s|#toml("/assets/conf.toml")|
      assert insert("feed.xml") == ~s|#xml("/assets/feed.xml")|
      assert insert("notes.txt") == ~s|#read("/assets/notes.txt")|
    end

    test "a font inserts a set rule once its family is known" do
      assert insert("Brand.ttf") == nil

      assert insert("Brand.ttf", %{"assets/Brand.ttf" => ["Brand Sans", "Brand Display"]}) ==
               ~s|#set text(font: "Brand Sans")|
    end

    test "a web font has nothing to insert" do
      assert insert("web.woff2") == nil
    end

    test "quotes and backslashes are escaped inside the Typst string" do
      assert insert(~S|a"b\c.png|) == ~S|#image("/assets/a\"b\\c.png")|
    end
  end
end
