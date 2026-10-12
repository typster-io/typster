#let x = xml("c.xml").first()
= Books

#for b in x.children.filter(c => type(c) == dictionary) [
  - #b.children.filter(c => type(c) == dictionary).map(c => c.children.join()).join(" / ")
]

After xml.
