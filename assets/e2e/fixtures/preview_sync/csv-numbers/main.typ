#let thousands(n) = { let s = str(n); let out = ""; let k = s.len(); for (i, ch) in s.clusters().enumerate() { if i > 0 and calc.rem(k - i, 3) == 0 { out += "," }; out += ch }; out }
= Prices

Price list below.

#let rows = csv("p.csv").slice(1)
#table(columns: 3, ..rows.map(r => (r.at(0), str(calc.round(float(r.at(1)), digits: 2)), thousands(int(r.at(2))))).flatten())

After the prices.
