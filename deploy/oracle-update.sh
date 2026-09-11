#!/bin/sh
set -eu
# Keep tracked candidate files readable by Docker's node user.
umask 022
exec python3 "$(dirname "$0")/oracle-update.py" "$@"
