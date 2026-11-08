= Shout

#let rows = csv("p.csv").slice(1)
#for r in rows [
  - #upper(r.at(0)) costs #r.at(1)
]

After shouting.
