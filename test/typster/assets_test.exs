defmodule Typster.AssetsTest do
  use Typster.DataCase, async: true

  import Typster.ProjectsFixtures

  alias Typster.Assets

  describe "kind/1 and font?/1" do
    test "classifies by extension, case-insensitively" do
      assert Assets.kind("Brand.ttf") == :font
      assert Assets.kind("brand.OTF") == :font
      assert Assets.kind("family.ttc") == :font
      assert Assets.kind("web.woff2") == :web_font
      assert Assets.kind("logo.png") == :image
      assert Assets.kind("notes.pdf") == :other
    end

    test "only Typst-readable formats count as fonts" do
      assert Assets.font?("Brand.ttf")
      refute Assets.font?("web.woff")
      refute Assets.font?("logo.png")
    end
  end

  describe "preview_manifest/1" do
    setup do
      owner = Typster.AccountsFixtures.user_fixture()
      project = project_fixture(owner)
      %{owner: owner, project: project}
    end

    test "every asset gets the caller's URL, whatever its extension",
         %{owner: owner, project: project} do
      font = asset_fixture(project, owner, %{filename: "Brand.ttf", content_type: "font/ttf"})
      image = asset_fixture(project, owner, %{filename: "logo.png"})
      pdf = asset_fixture(project, owner, %{filename: "figure.pdf"})
      data = asset_fixture(project, owner, %{filename: "table.csv"})

      [font_entry, image_entry, pdf_entry, data_entry] =
        Assets.preview_manifest([font, image, pdf, data], &"/raw/#{&1.id}")

      assert font_entry.kind == "font"
      assert font_entry.reference_path == "assets/Brand.ttf"
      assert font_entry.url == "/raw/#{font.id}"

      # The preview compiler reads any file a document may name:
      # `#image("assets/figure.pdf")`, `#csv("assets/table.csv")`.
      assert image_entry.kind == "image"
      assert image_entry.url == "/raw/#{image.id}"
      assert pdf_entry.kind == "other"
      assert pdf_entry.reference_path == "assets/figure.pdf"
      assert pdf_entry.url == "/raw/#{pdf.id}"
      assert data_entry.url == "/raw/#{data.id}"
    end

    test "without a URL builder assets are listed but carry no url", %{
      owner: owner,
      project: project
    } do
      font = asset_fixture(project, owner, %{filename: "Brand.ttf"})
      pdf = asset_fixture(project, owner, %{filename: "figure.pdf"})
      [font_entry, pdf_entry] = Assets.preview_manifest([font, pdf])
      assert font_entry.kind == "font"
      refute Map.has_key?(font_entry, :url)
      refute Map.has_key?(pdf_entry, :url)
    end
  end

  describe "list_project_fonts/1" do
    test "returns only the project's Typst-readable fonts, by name" do
      owner = Typster.AccountsFixtures.user_fixture()
      project = project_fixture(owner)
      other = project_fixture(owner)

      asset_fixture(project, owner, %{filename: "Zeta.otf"})
      asset_fixture(project, owner, %{filename: "Alpha.ttf"})
      asset_fixture(project, owner, %{filename: "web.woff2"})
      asset_fixture(project, owner, %{filename: "logo.png"})
      asset_fixture(other, owner, %{filename: "Other.ttf"})

      assert Enum.map(Assets.list_project_fonts(project.id), & &1.filename) == [
               "Alpha.ttf",
               "Zeta.otf"
             ]
    end
  end
end
