= Reversed

#let a = csv("a.csv").slice(1)
#table(columns: 2, ..a.rev().flatten())

= Sorted

#let b = csv("b.csv").slice(1)
#table(columns: 2, ..b.sorted(key: r => r.at(1)).flatten())

= Retired only

#let c = csv("c.csv").slice(1)
#table(columns: 2, ..c.filter(r => r.at(1) == "retired").flatten())

After.
