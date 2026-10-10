# Preview ↔ source sync

Click a spot in the rendered preview to move the editor caret to its source
line; rest the caret in the editor to scroll the preview to the matching text
and flash it. Works across `#include`d files. Issue: typster-io/typster#149.

## How it works

- `assets/js/preview_sync.js` owns both directions. The worker protocol is
  unchanged except that a `compile` message carries a `requestId` the worker
  echoes in its `render` reply, so the SVG is paired with the exact sources
  that produced it.
- The SVG carries each text run's laid-out text in a hidden selection layer
  (`.typst-text > foreignObject .tsel`), in document order, each inside its
  page (`g.typst-page`). Pictures (`<image>`) are runs too, without text.
  (Image assets reach the compiler the way fonts do: the preview manifest
  carries their URL and the worker maps the bytes as shadow files. A file is
  fetched once some source text holds its name, and kept; one no source
  names is fetched only when a compile fails to load a file, for a path the
  document builds at runtime (`"assets/" + name + ".png"`): the worker then
  fetches every file not tried yet and compiles once more, and logs the
  first failure only when that retry does not follow. A URL that failed
  is not asked for again until the asset list changes.)
- The sources are flattened into a *virtual document*: the entry file with
  each included file spliced in after the line that includes it, then every
  other text source (CSV, JSON, YAML, BibTeX, `#import`ed modules) as an
  appendix of one region per file. Offsets map back to `{file, line, col}`.
  The appendix does not depend on the order the sources are listed in: a
  file another file includes is spliced into its first includer, the others
  come in the order the body names them (`#for f in ("a.typ", "c.typ") {
  include f }`, `csv("a.csv")`), then by path, so a note two chapters of a
  dynamic include loop both include lands on its file in any order.
  A light scan of each Typst file finds every `include` (`#include "x.typ"`,
  `#include("x.typ")`, a name bound by `#let`, inside `#{ ... }`, several on
  one line; not inside `/* */` comments, nested ones included, nor inside a
  `#let`, whose content renders where it is used; cycle- and depth-guarded)
  and marks what each character is for: text that may show verbatim
  (markup, content blocks, strings, raw, math, a literal like `#(key: 1)`)
  and what renders where it stands (text, a call, a `@ref`). Comments, code,
  argument names (`caption:`), markup syntax, the strings of `#set` rules
  and of a `#show` rule's selector or `set` transform (`numbering: "1."`),
  file names (`csv("a.csv")`), keys of the `.at` method (`p.at("city")`;
  a function the project names `at` prints its argument), strings compared
  in code (`r.at(1) == "retired"`) and the parentheses of a math attachment
  (`sum_(i=1)`) are never text, so nothing matches there. The values a
  `#show` rule hands its transform may print (`#show: project.with(title:
  "...")` sets the title from that string), so they are text. A content
  block starts its markup as a line does, so `[- #p.name]` holds a list
  marker; the scan keeps where list and enum markers (`- `, `+ `) stand.
  Lines inside comments, declarations and code bodies,
  `#v(...)`/`#pagebreak()` and the like produce nothing.
- Runs and sources are compared after the same folding: compatibility
  characters (math italic letters, ligatures, full-width forms) folded, a
  letter and the marks combining with it composed (`e` + U+0301 as `é`, so
  text typed decomposed, composed or mixed matches; each folded character
  maps back to its source cluster's start),
  format characters (soft hyphens, joiners) dropped, any whitespace run (an
  indented continuation line, `~`) for a space, every locale's quotation
  marks for `"` and `'` with the spaces around them optional (« » carry thin
  spaces), `---`/`--` for em/en dashes, escapes (`\$`) for the character.
  Leading and trailing punctuation of a run (the quotes Typst prints around a
  string value) is optional. A match covers whole words at both ends, except
  where Typst broke a word (its break hyphen is a soft-hyphen run of its own)
  or in a script written without spaces.
- A show rule whose transform is content around the element it shows
  (`#show heading: it => block[#it.body (Part)]`, `[Teil: #it.body]`, the
  parameter itself as `#it`) prints the literal text next to that
  placeholder around every element it matches: the scan keeps that text
  before and after it, up to the content block's bracket, through the code
  between (`[Kapitel #counter(heading).display(): #it.body]`: the pieces
  `Kapitel` and `:` with the code as a gap), or up to the code next to it.
  A run holding such text around a body, which the sources hold nowhere as
  a whole while they hold the body where an element the rule's selector
  names shows it (a heading line of the level asked for, a list or enum
  item, a call of the element's function or of a project function calling
  it or writing its markup, `#let chapter(t) = [= #t]`; any text for inline
  elements and selectors naming none), is aligned
  by its body alone (the heading, the strong text, the caption it shows);
  text the rule's code prints between a piece and the body (a number) may
  be dropped from the body's side. Afterwards the body keeps the spots it
  matched with, each stretch of the rule's text in it walks the rule, and
  what the code printed takes the code's start. So every heading, strong
  text or
  caption the rule shows keeps its own source, whatever its words, and the
  added text lands on the rule; a caret on the rule finds the first of
  them.
- Alignment goes from the strongest evidence to the weakest. Matched source
  is claimed, so the same text is not handed out twice (copies and a loop's
  shared literal words aside):
  1. A text rendered exactly as often as the sources hold it pairs with those
     occurrences in order (in a data file only with whole values, not a word
     inside a longer cell). The heaviest chain of pairs that keeps both run
     order and source order (a weighted longest increasing subsequence per
     region) is the backbone; text rendered out of order (an outline entry,
     a top float, a footnote at the page bottom) falls out of it instead of
     dragging the reading position. Printed data need not keep its file's
     order (a table printed reversed, sorted or filtered): a value with
     letters found once in its file pairs wherever it prints, a value
     repeated there takes the record (line) of the value printed next to it,
     and only the rest pairs in order. Each run is looked up by its rarest
     whole word through a word index, not by scanning the sources.
  2. Footnote texts are set at the bottom of their page, after the page's
     flow (which ends with its last run found in reading order outside a
     footnote), in the order of their `#footnote` calls. The runs after a
     page's flow pair with the texts of the calls (the arguments of each
     `footnote`) keeping both orders, so a short or repeated text (`Note
     1.`, `Ibid.`) goes to its own call, and the marker in the flow is left
     to its `#footnote`.
  3. Between two backbone runs, the remaining runs are matched inside the
     source between them, again as the heaviest chain (ties go to the later
     run, so a body heading wins its line over its outline entry). Runs
     printed from a data file are matched in that file, between the values
     already found there and from where the previous stretch left off: the
     files of the values around them and the files the stretch's source
     names. Repeated values thus walk down the rows. A run of punctuation
     alone takes no mark a Typst source writes against a word when another
     unplaced run of the stretch shows that word with it: an outline's
     leader dots never take the period of a header's `Стр.`.
  4. Text displaced by layout (a footnote, a float, a cell spanning rows, the
     words of a right-to-left line in visual order) takes its text where it
     occurs once, still free, in the lines of its backbone neighbours, else in
     the source of its page and the one before.
  5. A generated label (`Figure 1: `, `Fig. 1. – `, a custom separator) is
     dropped by trying the longest suffix of the run that its stretch holds;
     the suffix must carry most of the run's letters. A part before it that
     is a whole value of a data file or a definition's text (`- #d.lead runs
     the survey.`, `[Banner: #title]`) is no label: the run is a mixed run
     (7). A part before it that is not found as a whole but whose words are,
     in order on the suffix's line with only code between them and the
     suffix (`Totalt #folk.len() personer`), keeps those words' spots. A
     suffix inside a definition a call of the stretch reaches is that
     definition's text after an argument (`[Hallo #n, willkommen!]`): a
     mixed run too (7), so the first call's output does not take the text
     the later calls show again.
  6. The words in order, however punctuated (`("key", "short")` against
     `key,short`), in the body first.
  7. A run mixing literal text with values (`Held in #d.city`, a loop's
     `- #r.at(0) costs #r.at(1)`) lives where its literal words are, found in
     order among the free text of its stretch (a loop shows them once per
     item, so they stay shared; the words may skip the code that printed the
     values, not other text; of several stretches of them, the one that
     accounts for most of the run, each word counted as often as the run
     shows it, so `Hello` thrice from `[Hello #name. ]` wins over two names
     of the array the loop walks). The literal may be a function's that the
     stretch calls (`#for p in folk [#rad(p)]` with `#let rad(p) = [#p.name
     lives in #p.city]`): its words in that definition, together with the
     run's words the call writes in its own arguments (`#ficha("Lucía",
     "Sevilla")`, `#ficha[Lucía][Sevilla]`), when they account for more of
     the run and values are left; the run then counts as printed by the
     call, as a template's text does, and a caret on the definition's text
     finds the first call's output. A word of the literal shown
     again takes its spot; the other words are looked up in the data files
     around it,
     else in order in the rest of the stretch (the array literal a `#for`
     walks), so a click on a value lands on that value. In a data file they
     take the shortest stretch after the values printed before them that
     holds them all, each in its own spelling when the file has it: the
     record a loop prints, so a value repeated in a later record stays in
     the one being printed, and `holm@example.org` is not the `Holm` of a
     name. A word found nowhere else that a function the stretch calls
     prints around its argument (`um #tag("8") und` with `#let tag(x) =
     [#x Uhr]`, `Danach #at("Museum")` with `[Treffpunkt: #place]`) takes
     the definition's spot, for every call; a variable's value (`#p.b`)
     stays on the code printing it.
  8. Data words in order; then text a function prints from its own
     definition (a template's ` --- ` between a term and its meaning, a
     closing `[.]`): a run between body runs whose source calls a function
     the project defines is looked up in that definition and the ones it
     calls, walked in order and started over only after something else
     printed in between (the next item's values), never after a later call
     or file name of the stretch has printed (`#csv(...)` after the
     glossary). Every call shows that text again, so it is not claimed. Then
     copies: text shown again with its source already taken (a running
     header, outline entries, a table printed twice) takes the next
     occurrence of its original after the last text read in that file,
     wrapping around, so a second copy walks its rows again; a value no run
     matched as such (a glossary listing rows that a raw print of the same
     CSV shows too) copies its whole field in the data file the same way.
  9. A run whose letters mostly come from one data file matches there by its
     words, from where the values printed before it end, the chain ending
     first among equally good ones (a record's own fields, not a repeated
     value further down); its words printed out of the file's order (a
     bibliography's authors before the title) are looked up in order in the
     record holding the rest, or in the shortest stretch holding them all
     when that finds more (a record of one field per line printed in
     another order). A value formatted on output (`1234.57`, `1,500`) takes
     the next field after the value before it, in the record of one of its
     neighbours; a key (`name:`, `name =`) is no field.
  10. Typst splits a word into runs where the font changes (a Cyrillic
      letter in a Latin word, `etеr`): runs touching inside a word that found
      nothing on their own are matched together where the sources hold their
      joined text once, and each keeps its piece.
  11. A running header or footer is set on every page from one content
      (`set page(header: context [Стр. #counter(page).display()])`). Right
      after displaced text (4), a run before or after the flow of its page
      (its first and last body runs) that found nothing and mixes literal
      words with values (`footer: [Internal draft · #title]`) takes its
      literal words in that content or in a definition the content calls
      (`header: mark()`), in whichever file the rule stands (a template's
      `set page` included), and its values where the names the content
      uses get them: the string of `#let title = "..."`, or for a parameter
      of the template holding the rule, what its first call passes
      (`#show: report.with(title: "...")`), even when the body prints that
      value too. It must account for more of the run than the body around
      it. Every page's copy maps the same way, and only the literal words
      are claimed, shared. Otherwise a run
      first or last on its page that found nothing, with the words (numbers
      aside) of a run at the same end of another page matched in text shown
      elsewhere (a `set` rule's content), is a copy of that run, its words
      at their spots (each word at the spot of the same word of that run,
      so `Sheet 2 of the log` keeps `of the log`). Runs that none matched
      (a `context` footer printing the page number) with the same words at
      the same end of several pages are copies found by those words in
      order in text shown elsewhere.
- Runs with nothing to match are placed between their neighbours. Pictures
  take the calls of their stretch that can produce one, in order (a call to
  `image` or to a name whose `#let` shows one, else the first call of a later
  line), so a grid of three takes its three lines, a one-line grid of two
  takes its line twice and a picture after its label on the same line stays
  on that line. Text with letters (`#lorem`, generated words) claims
  the line it shares the most words with, and the runs after it stay there
  until another claims a later line; else what is left to show on the
  previous run's line, else on the next run's line before it (`#cite(<k>,
  form: "prose")` printing the names before the sentence), else the first
  producing line. Marks without letters
  go with their neighbours: closing punctuation, and a mark set after a
  space (an outline entry's page number after its leaders), follows the text
  before it. A line between the texts around a mark that renders something
  nothing matched (`#context counter(page).display()`, not a `#for ... [`
  whose body is below) is the mark's source, and the marks right after it
  stay there while that output has a bracket open (`(1,)` from `.get()`) or
  nothing else is left to show before the next text (else a mark goes with
  that: the `∑` of a math line below). A bullet or number before a printed
  value goes to the line of the list marker of its stretch that printed it
  (`#for p in people [- #p.name ...]`), from the line of the text before it
  on. Else a marker (bullet, number, bracket) precedes the text after it,
  at its line start, unless the previous text's line still has something
  unshown (a `@ref`, a `#footnote`), which the mark then shows, up to its
  end; a mark before text that opens a later line plainly (no list or
  heading marker, no call before it, strong or emphasis aside, not a
  footnote's text) is no marker
  of it and ends the text before it (the `(1)` Typst sets after an
  equation's last glyph). A mark opening a later line reaches over the word
  that line leaves unshown before the text after it, so a caret on the
  `integral` of `$ integral_0^1 ... $` finds the `∫`. Inside
  printed data, a mark goes with the values around it, at the start of their
  record: a line, or a top-level bracket group when the file holds several
  (a BibTeX entry, so a bibliography label opens `@book{lee2018,`). A placed run spans its whole line, so
  a caret anywhere on `#lorem(400)` finds the paragraph. Scoring lines is
  capped (runs × lines of one stretch); past the cap, runs take the first
  producing line.
- Preview → source dispatches the existing `phx:editor-command` goto with
  `{file, line, col}`, where the column is the character under the pointer
  as the glyphs draw it: the run's `.typst-text` group holds one `<use>` per
  glyph at its pen position, each drawing one character or, for a ligature,
  `1 + data-liga-len` (as typst.ts's own text layout reads them). This
  renderer leaves most ligatures unmarked (`fi`, `fl`, `fj`), so when the
  glyphs miss the characters the run's words are paired with its glyphs at
  whitespace and blank glyphs, and inside a word a glyph the page draws
  elsewhere for one character keeps it while the rest take the characters
  whose widths best fill their advances. Inside a glyph its characters share
  its advance; the left half of a character's share puts the caret before
  it. The hidden text layer (set in the browser's font, narrower or wider
  than the glyphs) is used only when the glyphs cannot be read: a picture,
  right-to-left text, glyphs that do not pair with the words. The
  characters before the pointer then map to the source: a matched run keeps
  a spot per character of its folded text, found by
  walking that text against the source it matched with the same folding (an
  escape such as `\$`, `---` or a literal em dash, quotes with or without
  their thin spaces, a dropped soft hyphen or joiner), so nothing before the
  click shifts it; a run matched by its words walks each word from its own
  spot, into the data file for the values of a mixed run, and a mark it
  shows right before a word that the source writes right before it too (the
  `+` of `+39 055`) goes there; a word found nowhere right after text that
  was, where the source goes on with code (`In all #crew.len() sailors`,
  `[Sheet #counter(page).display() of the log]`, past marks the source
  spells as the run does: `Nimi: #p.at("name")`, a quotation mark as any:
  `und „#p.b“`), goes to that code's `#`;
  a run placed on a
  line rather than
  matched (generated text) sends the caret to that line's end, a marker to
  its point. The CodeMirror hook moves the caret directly for the
  active file, otherwise pushes `open_path` and completes the move once the
  new buffer mounts. Each `open_path` carries a sequence number the server
  echoes in `file_changed` and `content_updated`; only the reply to the
  latest request switches buffers and runs its move, and while one is
  unanswered a goto into the shown file is sent as a request too, so the
  last click wins on a slow link. A goto also cancels a caret-follow still
  waiting on its delay. The server re-reads the project's files on every
  open, so another session's saves reach the compile, and the goto carries
  the file text the location was found in: when the buffer holds newer
  text, the hook finds the same spot in it (`relocate`): text outside the
  changed stretch moves by the change's length, and inside it a line diff
  sends a kept line to its partner (the right copy of a repeated line) and
  an edited line to the most alike line that replaced it, at the clicked
  word.
- The preview keeps compiling the file you were previewing (the *entry*):
  a jump into an `#include`d chapter or a data file sends `project.entryPath`
  with every compile, the worker maps the live buffer at its own path and
  compiles the entry from the saved sources, and edits in the jumped-to
  buffer (even a CSV) re-render the whole document. Every `file_changed`
  carries a `reason`: a selection from the tree or a tab ("select") or a new
  file ("create") makes that file the entry when it is a Typst file; a jump
  ("jump"), a closed tab ("close"), a deleted file ("delete") or opening a
  data file (CSV, BibTeX, a note) keep the current entry while it is a
  `.typ` file that still exists. Opening a CSV from the tree therefore keeps
  previewing the document, and editing the CSV re-renders it. The hook also
  watches `data-project-sources` (LiveView merges it on every save, create,
  move or delete) and recompiles when a sibling source changed or the entry
  vanished. The PDF download is the entry document and takes its name.
- A pending autosave is flushed before any buffer switch, and the server
  stores a save for a file that is no longer current, so the last edits
  before a jump or a tree click are not lost. Re-selecting the active file
  pushes the pending save instead of taking the server's older copy. Moving
  the open buffer in the tree sends `file_moved`, which updates the path the
  compiler maps it at without re-creating the editor.
- The Problems drawer's rows and "Jump to first" carry the diagnostic's file,
  so an error in another file opens it.
- Source → preview runs 250 ms after a caret move that is not an edit, scrolls
  the pane only when the run is out of view, and flashes `.ts-preview__flash`
  only when the target run changed. A click beside the text picks the run on
  the same line first. A caret finds the run its text is in, matched text
  before copies (an outline entry, a header) and placed lines, and a value a
  mixed run shows counts as inside it (a caret on a CSV row finds the loop
  item that printed it); between two runs that touch (`(` then `birds`) the
  one starting there; a mark placed at what it shows (`Section 1` at
  `@intro`, a footnote marker at `#footnote`) counts that whole reference or
  call. Else the next run on its line, a value a run shows
  there included (a caret on `== `, on `caption: [` or on a data key finds
  the run printing that record), then a mark placed right there, then the
  run before it on its line (a comment after the text), not a mark placed
  at a Typst line's start (a loop's bullet: the caret on the loop body
  finds the item). A caret on a line
  whose own text matched nothing (`#table(..csv("a.csv"))`, `#read(...)`,
  `#for a in d.authors [...]`, `#greeting`, a call printing a template)
  finds the runs printed between the body runs around it: those that line
  printed first (a template's text by the line calling it, values by the
  line naming their file, placed runs by their line; the runs in between by
  the lines in between, and a call's arguments and closing bracket by the
  call; the values of one named file share its reach, so a caret on
  `#table(..rows.flatten())` finds the first), the one sharing a word with
  the line first. A caret on a line of a function's definition that names
  one of its parameters finds what the first call passed for it (the title
  of `project.with(title: "...")` from `text(17pt, title)`); the last
  positional one a `#show: name.with(...)` rule leaves out (`body`) is the
  rest of the document. That argument also wins over the text before the
  caret on its line when the line names the parameter past that text
  (`[Achtung #level:] #msg`). Else the nearest run
  after the caret in its own file, else before it; in a data file a line
  closing a bracket (a BibTeX entry's `}`) belongs to the record above it,
  and a file the document does not render (a commented-out include, a stale
  CSV) finds nothing.

## Why text alignment, not spans

The bundled typst.ts (0.8.0-rc3) exposes no span resolver to JavaScript: the
renderer's `source_span` reads page source mappings that the incremental
server no longer packs into the artifact, and the web compiler has no
`resolve_span`. Text alignment needs nothing from the compiler and follows
unsaved buffers.

## Known limits

- Text generated at compile time (numbering, references, computed values)
  has no source text to match and is placed by its neighbours; text read
  from a project data file resolves to that file, a run mixing both to its
  literal part.
- A text rendered more often than the sources hold it maps the extra
  renders to copies; when a body text and its copy are rendered in the same
  stretch, the later one is taken for the body.
- Only `include` is spliced. Text a function prints is found in its
  definition when the project defines it (an `#import`ed module of the
  project included); a package's functions (`@preview/...`) are not in the
  sources, so what they print is placed by its neighbours.
- The marks after one that a line's own output placed stay with it when the
  next text's source shows nothing else first, so a list bullet right after
  `#context counter(page).display()` goes to that line.
- A list bullet printed for data by a function or a `#list(..)` call (no
  `- `/`+ ` marker in the stretch) still goes to the record of the value
  after it.
- A running header or footer is found as a copy once its text matched on
  some page, or when several pages show its words at the same end and those
  words are in text shown elsewhere; on another page only at the same end
  of the page. One set only on later pages, or whose words change from page
  to page (the current heading's title), is placed by its neighbours.
- Right-to-left text, and a run whose glyphs do not pair with its words, is
  read off the hidden text layer, whose font differs from the glyphs: a
  click there can land a character or two off. Vowelled Arabic (harakat)
  is set as one run per letter cluster; such short runs match wherever the
  line holds the cluster, so some go to another word of the line or to its
  end.
- A picture from a function the sources do not define (a package) takes the
  first call line of its stretch.
- Text transformed on output (`#upper`, `#smallcaps`, a `show` rule
  computing its text) matches only by its words, ignoring case; a value
  formatted on output takes its field by position. A show rule's literal
  text is split off only from a run holding all of it around the body; set
  in a run of its own (another font), it is matched as a copy of the rule's
  text. A run that is not the selected element but prints the rule's
  literal (`#title (Draft)` beside `#show heading: it => [#it.body
  (Draft)]`) may still take that literal from the rule.
- A word Typst sets in two runs because a character comes from another font
  (a ligature character such as `ﬁ` in the source) is matched as one only
  when neither part found its text alone; otherwise the part that did loses
  its first or last letters to a whole-word match.
- A caret on a definition line finds a call's argument only for a parameter
  passed by name or position as a string, content block or array; one
  computed from other parameters, or passed through a variable, finds the
  nearest text of the definition, if any. A click on a value passed through
  a variable (`#gruss(wer)`) lands on the definition's placeholder, not on
  the variable's string.
- A run first or last in a page's flow that shares a word with a `set page`
  header or footer can be taken for it: an outline entry or a closing
  paragraph then lands on the page rule.
- A footnote before a data loop can pull the loop's mixed runs (a value
  plus literal words) to the end of the footnote's paragraph.
- Pictures in a table or grid row built by a data loop: the second and
  later ones can land on a neighbouring line instead of their `image()`
  call. A heading that prints a variable (`= #title`) lands on the let
  string; a rule's literal symbol before the body (`[§ #it.body]`) lands on
  the heading text.
- Between a keystroke and the next compile the preview still reflects the
  previous buffer, so line numbers can drift by the edit until it recompiles.

## Tests

- `assets/e2e/preview_sync_align.spec.mjs` aligns runs recorded from the
  worker (`assets/e2e/fixtures/preview_sync/`, one document per shape)
  without a browser, in the default `chromium` project. Re-record a fixture
  when Typst's output changes: render its files through
  `/assets/js/typst_worker_impl.js` and save each `.tsel` run's text and page
  index, and each `<image>` as an image run.
- `assets/e2e/preview_sync.spec.mjs` drives the editor (authenticated).
