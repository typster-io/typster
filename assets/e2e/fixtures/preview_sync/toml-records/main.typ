#let cfg = toml("crew.toml")
= Crew

#for m in cfg.member [
  - #m.name (#m.role)
]

That is everyone.
