#!/bin/sh
set -eu

cd "$(git rev-parse --show-toplevel)"
git submodule update --init -- .agents/anthropic-skills

# Only the upstream directories listed here are generated. Project skills live alongside them.
while IFS= read -r directory; do
  case "$directory" in
    /*/) ;;
    *) continue ;;
  esac
  name=${directory#/}
  name=${name%/}
  source=.agents/anthropic-skills/skills/$name
  test -f "$source/SKILL.md"
  rsync -a --delete "$source/" ".agents/skills/$name/"
done < .agents/skills/.gitignore
