#let project(title: "", authors: (), body) = {
  set document(title: title)
  align(center, text(17pt, weight: "bold", title))
  align(center, authors.join(", "))
  [Prepared for the field station.]
  body
}
