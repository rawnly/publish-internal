#!/usr/bin/env bash
#MISE name='vendor'

jq -r '.vendors[]' .vendors.lock | while IFS= read -r entry; do
  repo="${entry%%#*}";
  ref="${entry#*#}";
  name="$(basename "$repo")";
  name="${name%.git}";
  dest="vendor/$name";
  echo "Cloning $repo @ $ref -> $dest";
  git clone --depth 1 "$repo" -b "$ref" "$dest";
  rm -rf "$dest/.git";
done
