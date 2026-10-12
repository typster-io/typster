#let folk = json("data/folk.json")
#let rad(p) = [#p.namn bor i #p.at("stad") och är #p.alder år.]
#set text(lang: "sv")
= Deltagare

#for p in folk [
  #rad(p)

]

Totalt #folk.len() personer deltog.
