defmodule Typster.Assets.Asset do
  @moduledoc "Schema for stored asset metadata and object references"
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  @type t :: %__MODULE__{}

  schema "assets" do
    field :object_key, :string
    field :content_type, :string
    field :size, :integer
    field :filename, :string
    belongs_to :project, Typster.Projects.Project
    field :inserted_at, :utc_datetime
  end

  @doc false
  def changeset(asset, attrs) do
    asset
    |> cast(attrs, [:object_key, :content_type, :size, :filename])
    |> validate_required([
      :object_key,
      :content_type,
      :size,
      :filename,
      :project_id,
      :inserted_at
    ])
    |> unique_constraint([:project_id, :object_key])
  end
end
