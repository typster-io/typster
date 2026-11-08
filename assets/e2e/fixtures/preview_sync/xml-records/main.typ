#let crew = xml("crew.xml").first()
#let field(m, tag) = m.children.find(c => type(c) == dictionary and c.tag == tag).children.first()
= Crew

#for m in crew.children.filter(c => type(c) == dictionary) [
  - #field(m, "name") (#field(m, "role"))
]

That is everyone.
