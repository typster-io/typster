#let d = yaml("staff.yaml")
- #d.lead runs the survey.
- Contact: #d.mail

#for (k, v) in d.rooms [
  + Room #k: #v
]

The end.
