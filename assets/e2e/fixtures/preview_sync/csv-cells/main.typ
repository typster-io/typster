= Birds

Opening paragraph about kestrels.

#table(columns: 2, ..csv("d.csv").map(r => (r.at(0), r.at(2))).flatten())

Closing paragraph about herons.

= Cities

#table(columns: 3, ..csv("a.csv").flatten())

Oslo is the biggest city in the table and its country is Norway.

The pop column is in thousands.

= Members

#table(columns: 2, ..csv("s.csv").flatten())

After the table.
