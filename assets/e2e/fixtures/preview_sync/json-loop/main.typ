= Roster

#let people = json("people.json")
#for p in people [- #p.name, age #str(p.age), from #p.city
]

End of roster.
