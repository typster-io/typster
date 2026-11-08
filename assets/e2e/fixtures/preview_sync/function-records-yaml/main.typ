#let folk = yaml("folk.yaml")
#let rad(p) = [#p.namn bor i #p.stad och är #p.alder år.]
#set text(lang: "sv")
= Deltagare

#for p in folk [
  #rad(p)

]

Totalt #folk.len() personer deltog.
