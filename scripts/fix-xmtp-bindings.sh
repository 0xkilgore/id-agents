#!/bin/bash
# Fix XMTP native bindings on macOS (nix-linked libiconv)
if [ "$(uname)" != "Darwin" ]; then exit 0; fi

find node_modules/@xmtp -name "bindings_node.darwin-arm64.node" 2>/dev/null | while read f; do
  if otool -L "$f" 2>/dev/null | grep -q "/nix/"; then
    NIX_ICONV=$(otool -L "$f" | grep "/nix/" | grep "libiconv" | awk '{print $1}')
    if [ -n "$NIX_ICONV" ]; then
      install_name_tool -change "$NIX_ICONV" /usr/lib/libiconv.2.dylib "$f" 2>/dev/null
      codesign --force --sign - "$f" 2>/dev/null
      echo "[fix-xmtp] Fixed: $f"
    fi
  fi
done
