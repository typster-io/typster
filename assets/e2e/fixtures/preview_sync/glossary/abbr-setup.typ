// Читаем CSV стандартным, чистым способом (без ручных срезов индексов)
#let my-glossary-entries = csv("abbr-list.csv", row-type: dictionary)