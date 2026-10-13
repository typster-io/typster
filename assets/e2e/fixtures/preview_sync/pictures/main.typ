#let pic(w) = image("assets/dot.png", width: w)
= Pictures

Intro about kestrels.

#grid(
  columns: 3,
  image("assets/blue.png", width: 1cm),
  image("assets/green.png", width: 1cm),
  image("assets/dot.png", width: 1cm),
)

Between the pictures.

#image("assets/blue.png", width: 1cm)

#image("assets/green.png", width: 1cm)

Before the alias.

#v(1em)
#pic(1cm)

#table(columns: 2,
  [Blue], image("assets/blue.png", width: 5mm),
  [Green], image("assets/green.png", width: 5mm),
)

A sentence ending with an icon #box(image("assets/dot.png", height: 1em))

After about herons.
