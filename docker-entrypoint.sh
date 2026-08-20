#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  target_uid="${PUID:-99}"
  target_gid="${PGID:-100}"
  if [ "$(id -g node)" != "$target_gid" ]; then groupmod -o -g "$target_gid" node; fi
  if [ "$(id -u node)" != "$target_uid" ]; then usermod -o -u "$target_uid" node; fi
  chown -R node:node /data /config
  exec gosu node "$@"
fi

exec "$@"
