#let y = yaml("c.yaml")
= Config

#y.title by #y.owner.name

#table(columns: 2, ..y.items.map(i => (i.label, str(i.qty))).flatten())

After yaml.
