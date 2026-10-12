#import "abbr-setup.typ": *

// === НАЧАЛО === // Блока кода для модификации
//                // стандартного вида выводимого глоссария GLOSSARIUM

#import "@preview/glossarium:0.5.10": *
#import "abbr-setup.typ": *

// Helper logic can stay outside if they are pure utility functions,
// but even they can go inside if you prefer absolute isolation.
#let has-long(entry) = entry.keys().contains("long")
#let has-description(entry) = entry.keys().contains("description")


#let custom-print-glossary(
  entries,
  disable-print-description: false,
  disable-back-references: false,
  title-weight: 600,
  long-width: 19cm,
  description-width: 5cm,
  ..other-args,
) = {
  // 1. Local Title Render
  let my-print-title(entry) = {
    let caption = []
    let txt = text.with(weight: title-weight)
    if has-long(entry) {
      caption += (
        txt(entry.short) + txt([ --- ]) + entry.long
      )
    } else {
      caption += txt(entry.short)
    }
    return caption
  }

  // 2. Local Description Render
  let my-print-description(entry) = {
    let ent-description = entry.at("description", default: "")
    return text()[#box(width: description-width)[(#ent-description)]]
  }

  // 3. Local Back-References Render
  let my-print-back-references(entry) = {
    // TODO: Смотри ниже: Сделать так, чтобы не было повторов страниц, где появляется аббревиатура
    return get-entry-back-references(entry).join(", ")
  }

  // 4. Local Main Entry Layout Compiler
  let my-print-gloss(
    entry,
    show-all: false,
    disable-back-references: false,
    user-print-title: none,
    user-print-description: none,
    user-print-back-references: none,
    ..args,
  ) = context {
    let caption = []
    if show-all == true or count-refs(entry.key) != 0 {
      caption += user-print-title(entry)

      if (not disable-print-description) and has-description(entry) {
        caption += ": "
        caption += user-print-description(entry)
      }

      if disable-back-references != true {
        caption += " "
        caption += user-print-back-references(entry)
      }
    }
    return caption
  }

  // --- ПОЛНЫЙ ОТКАЗ ОТ PRINT-GLOSSARY И MY-PRINT-REFERENCE ---
  context {
    // 1. Принудительно сбрасываем выравнивание на левый край для всего текста ниже
    set align(left)

    // 2. Жестко фиксируем шаг между абзацами (spacing) и строками (leading)
    // Именно 'spacing: X.Xem' будет управлять вертикальным расстоянием между аббревиатурами!
    set par(spacing: 1.0em, leading: 0.65em, justify: false)

    // 3. Обнуляем скрытые отступы для внутренних фигур, которые мы используем для ссылок
    show figure.where(kind: "__glossarium_figure"): set figure(gap: 0pt)
    show figure.where(kind: "__glossarium_figure"): set block(
      above: 0pt,
      below: 0pt,
      spacing: 0pt,
    )

    // 4. Рендерим элементы через чистый текстовый цикл
    let total = entries.len()
    for (idx, entry) in entries.enumerate() {
      // Генерируем ГОСТ-контент сокращения отдельно, чтобы использовать его дважды
      let gloss-content = my-print-gloss(
        entry,
        show-all: true,
        disable-back-references: disable-back-references,
        user-print-title: my-print-title,
        user-print-description: my-print-description,
        user-print-back-references: my-print-back-references,
      )

      // Передаем пакету ОДИН ТЕКУЩИЙ ЭЛЕМЕНТ в виде массива из одного объекта.
      // Обнуляем отображение всех частей через пустые функции '(_) => []'.
      // Сама фигура и метка создаются точно здесь, и клик перенесет пользователя сюда!
      place(hide(block(
        print-glossary(
          (entry,), // Передаем как массив из одного элемента
          disable-back-references: disable-back-references,
          user-print-title: _ => [],
          user-print-description: _ => [],
          user-print-back-references: _ => [],
        ),
      )))

      // Выводим скомпилированную текстовую строку сокращения
      gloss-content
            // Точки с запятой в конце определений и точка в самом конце списка
      // Сделать потом эту функцию опциональной
      if idx != total - 1 {
        [;]
      } else { [.] }

      // Делаем принудительный разрыв абзаца для компактного шага
      parbreak()
    }
  }
}
// === КОНЕЦ === // Блока кода для модификации
//               // стандартного вида выводимого глоссария GLOSSARIUM


// === НАЧАЛО === // Основного текста документа

// TODO: Разобраться, почему если изменить название этой части документа,
//      то он воспринимается как один из разделов НИР,
//      то есть ему присваивается сквозной номер и заголовок оформляется как у раздела НИР

= Перечень сокращений и обозначений <перечень-сокращений-и-обозначений>

// Строчка для соответствия ГОСТу ("В настоящем отчёте о НИР...")
#[
  // Локально изменим межсимвольное расстояние (tracking), чтобы вся строчка поместилась
  #show text: set text(tracking: -0.25pt)
  В настоящем отчёте о НИР применяют следующие сокращения и обозначения: \
  #box()[]
]
#[
  // Сделаем локальный нулевой отступ (для соответствия ГОСТу)
  #set par(first-line-indent: 0.0cm)
  // Вызов кастомной функции вывода глоссария (списка аббревиатур)
  #custom-print-glossary(
    my-glossary-entries, // Список аббревиатур, импортированный из CSV-файла
    disable-back-references: true, // Убирать или нет вообще ссылки на страницы, где есть аббревиатура
    // TODO: Смотри ниже: Сделать так, чтобы не было повторов страниц, где появляется аббревиатура
    deduplicate-back-references: true, // Смотри выше: Убирать или нет дублирующиеся ссылки на страницы, где есть аббревиатура
    disable-print-description: true, // Убирать или нет определение (понятие) сущности аббревиатуры
  )
]

// === КОНЕЦ === // Основного текста документа
