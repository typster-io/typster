#let y = yaml("c.yaml")
= Config

#y.title by #y.owner.name

#table(columns: 2, ..y.items.map(i => (i.label, str(i.qty))).flatten())

After yaml.

#let x = xml("c.xml").first()
= Books

#for b in x.children.filter(c => type(c) == dictionary) [
  - #b.children.filter(c => type(c) == dictionary).map(c => c.children.join()).join(" / ")
]

After xml.
