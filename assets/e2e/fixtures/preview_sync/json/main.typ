#let d = json("c.json")
= Survey

Title: #d.title

#for a in d.authors [
  - #a.name (#a.tags.join(", "))
]

Held in #d.meta.place.city, #d.meta.place.country, #d.meta.year.

#for n in d.notes [#n. ]

The end.
