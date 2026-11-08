#let warn(msg, level: 1) = block[
  #text(weight: "bold")[Achtung #level:] #msg
]
= Hinweise

#warn("Akku schwach", level: 2)

#warn("Tür offen")

Sonst alles gut.
