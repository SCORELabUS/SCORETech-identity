#!/bin/sh
set -eu
if [ -n "${KC_DB_PASSWORD_FILE:-}" ]; then KC_DB_PASSWORD="$(cat "$KC_DB_PASSWORD_FILE")"; export KC_DB_PASSWORD; fi
if [ -n "${KC_BOOTSTRAP_ADMIN_PASSWORD_FILE:-}" ]; then KC_BOOTSTRAP_ADMIN_PASSWORD="$(cat "$KC_BOOTSTRAP_ADMIN_PASSWORD_FILE")"; export KC_BOOTSTRAP_ADMIN_PASSWORD; fi
exec /opt/keycloak/bin/kc.sh "$@"
