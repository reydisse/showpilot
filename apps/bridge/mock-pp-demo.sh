#!/bin/sh
set -eu

PP_BASE_URL="${MOCK_PP_URL:-http://127.0.0.1:1025}"
KIOSK_BASE_URL="${MOCK_KIOSK_URL:-http://127.0.0.1:9460}"
STEP_DELAY="${STEP_DELAY:-2}"

say() {
  printf '\n== %s ==\n' "$1"
}

post() {
  curl -fsS -X POST "$1"
  printf '\n'
}

get() {
  curl -fsS "$1"
  printf '\n'
}

pause() {
  sleep "$STEP_DELAY"
}

say "Kiosk on"
post "$KIOSK_BASE_URL/on"
pause

say "Next slide"
get "$PP_BASE_URL/v1/trigger/next"
pause

say "Next slide"
get "$PP_BASE_URL/v1/trigger/next"
pause

say "Previous slide"
get "$PP_BASE_URL/v1/trigger/previous"
pause

say "Glitchy next transition"
post "$PP_BASE_URL/mock/glitch-next"
pause

say "Clear slide"
post "$PP_BASE_URL/mock/clear"
pause

say "Kiosk off"
post "$KIOSK_BASE_URL/off"
pause

say "Final kiosk status"
get "$KIOSK_BASE_URL/status"
