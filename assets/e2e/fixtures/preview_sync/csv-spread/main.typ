= Table

#let rows = csv("birds.csv")
#table(columns: 3, ..rows.flatten())

The table lists three species.
