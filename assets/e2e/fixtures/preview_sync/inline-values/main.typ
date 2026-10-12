#let v = toml("conf/viaggio.toml")
#set text(lang: "it")
= #v.titolo

La nostra guida è #v.guida.nome, raggiungibile al #v.guida.telefono.

#for t in v.tappe [
  - #t.citta: #t.notti notti
]

Arrivederci e buon viaggio!
