#!/bin/sh
set -eu
# Run an inspected, downloaded script. VERSION must be an explicit release tag (for example 1.0.0).
version=${VERSION:?Set VERSION to the release version, without the v prefix}
case "$version" in *[!0-9A-Za-z._-]*|'') echo 'Invalid VERSION' >&2; exit 1;; esac
case $(uname -s) in Linux) platform=linux;; Darwin) platform=darwin;; *) echo 'Use install.ps1 on Windows.' >&2; exit 1;; esac
case $(uname -m) in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo 'Unsupported architecture.' >&2; exit 1;; esac
name="tabby-hub-$version-$platform-$arch"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT HUP INT TERM
if [ -n "${ARCHIVE_DIR:-}" ]; then
  cp "$ARCHIVE_DIR/$name.tar.gz" "$ARCHIVE_DIR/SHA256SUMS" "$tmp/"
elif command -v gh >/dev/null 2>&1; then
  gh release download "v$version" --repo Sojaner/tabby-hub-mcp --pattern "$name.tar.gz" --pattern SHA256SUMS --dir "$tmp"
else
  base="https://github.com/Sojaner/tabby-hub-mcp/releases/download/v$version"
  curl -fL --proto '=https' --tlsv1.2 "$base/$name.tar.gz" -o "$tmp/$name.tar.gz"
  curl -fL --proto '=https' --tlsv1.2 "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
fi
expected=$(awk -v name="$name.tar.gz" '$2==name {print $1}' "$tmp/SHA256SUMS")
[ ${#expected} -eq 64 ] || { echo 'Missing release checksum.' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp/$name.tar.gz" | awk '{print $1}'); else actual=$(shasum -a 256 "$tmp/$name.tar.gz" | awk '{print $1}'); fi
[ "$expected" = "$actual" ] || { echo 'Release checksum mismatch.' >&2; exit 1; }
destination="${INSTALL_DIR:-$HOME/.local/share/tabby-hub}/$version-$platform-$arch"
mkdir -p "$(dirname "$destination")"
tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
if [ -e "$destination" ]; then echo "Version already exists: $destination (remove it explicitly to reinstall)." >&2; exit 1; fi
mv "$tmp/$name" "$destination"
"$destination/bin/tabby-hub" install "$@"
mkdir -p "$HOME/.local/bin"
escaped=$(printf '%s' "$destination/bin/tabby-hub" | sed "s/'/'\\\\''/g")
printf "#!/bin/sh\nexec '%s' \"\$@\"\n" "$escaped" > "$HOME/.local/bin/tabby-hub"
chmod 755 "$HOME/.local/bin/tabby-hub"
echo "Installed $version. Add $HOME/.local/bin to PATH; restart Tabby windows."
