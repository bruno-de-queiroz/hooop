#!/usr/bin/env bash
# End-to-end check of the pairing surface against a LIVE install: enrolling one of
# your own devices, inviting a guest, and — the part that keeps biting — what
# happens to each of them once their grant is revoked.
#
# Runs against the real HTTP contract rather than the UI, because that is where the
# bugs were: every defect found by hand in this feature (a revoked device shadowing
# a live peer share, a device landing on the new-session form, a device that read
# "not used yet" while in use) is visible from curl and invisible to a unit test
# with a mocked sandbox.
#
# Run it ON THE DOCKER HOST, where localhost:7842 is the dashboard:
#     ./plugins/hooop/dashboard/e2e-pairing.sh
#
# It needs the tunnel, so it will start one if none is running. It creates its own
# session, its own device and its own share, and removes all three on the way out.
# It never touches anything it did not create.
#
# Needs: curl, jq.
set -uo pipefail

BASE="${HOOOP_BASE:-http://localhost:7842}"
TOKEN_FILE="${HOOOP_DASHBOARD_TOKEN_FILE:-$HOME/.local/share/hooop/dashboard.token}"
JAR_DIR="$(mktemp -d)"
PASS=0; FAIL=0
# Defined up front: the EXIT trap is armed before these are read, and `set -u`
# turns an unbound variable in the trap into a confusing second failure on top of
# whatever actually went wrong.
TOKEN=""; TUNNEL=""
SESSION_ID=""; SHARE_ID=""; DEVICE_ID=""; STARTED_TUNNEL=0

red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
dim() { printf '\033[2m%s\033[0m\n' "$*"; }

ok()   { PASS=$((PASS+1)); grn "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); red "  FAIL  $1"; [ $# -gt 1 ] && dim "        $2"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Assert helper: expect "$actual" to equal "$expected".
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected $3, got $2"; fi
}
# Assert helper: expect "$haystack" to contain "$needle".
has() {
  case "$2" in *"$3"*) ok "$1";; *) bad "$1" "expected to contain '$3', got: $(printf '%s' "$2" | head -c 200)";; esac
}

cleanup() {
  step "Cleanup"
  if [ -z "$TOKEN" ]; then rm -rf "$JAR_DIR"; exit 1; fi
  if [ -n "$DEVICE_ID" ]; then
    host POST "/api/host-device/$DEVICE_ID/revoke" >/dev/null 2>&1 && dim "  revoked device $DEVICE_ID"
  fi
  if [ -n "$SHARE_ID" ]; then
    host POST "/api/share/$SHARE_ID/revoke" >/dev/null 2>&1 && dim "  revoked share $SHARE_ID"
  fi
  if [ -n "$SESSION_ID" ]; then
    host DELETE "/api/sessions/$SESSION_ID" >/dev/null 2>&1 && dim "  deleted session $SESSION_ID"
  fi
  if [ "$STARTED_TUNNEL" = "1" ]; then
    dim "  leaving the tunnel running (it was started by this script; stop it from the UI if you want it down)"
  fi
  rm -rf "$JAR_DIR"
  printf '\n'
  if [ "$FAIL" -eq 0 ]; then grn "$PASS passed, 0 failed"; else red "$PASS passed, $FAIL FAILED"; fi
  exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
}
trap cleanup EXIT INT TERM

# ── request helpers ─────────────────────────────────────────────────────────────
# The HOST, on localhost: the install cookie plus the same value as the
# double-submit header, which is what the browser's fetch patch does.
host() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-s -X "$method" -H "Cookie: hooop_token=$TOKEN" -H "x-dashboard-token: $TOKEN"
              -H "Origin: $BASE" -H "Content-Type: application/json")
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}" "$BASE$path"
}
host_code() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method" -H "Cookie: hooop_token=$TOKEN"
              -H "x-dashboard-token: $TOKEN" -H "Origin: $BASE" -H "Content-Type: application/json")
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}" "$BASE$path"
}
# A viewer out on the tunnel, identified only by whatever cookies it carries.
tun() {
  local method="$1" path="$2" cookie="${3:-}" body="${4:-}"
  local args=(-s -X "$method" -H "Origin: $TUNNEL" -H "Content-Type: application/json")
  [ -n "$cookie" ] && args+=(-H "Cookie: $cookie")
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}" "$TUNNEL$path"
}
tun_code() {
  local method="$1" path="$2" cookie="${3:-}" body="${4:-}"
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method" -H "Origin: $TUNNEL" -H "Content-Type: application/json")
  [ -n "$cookie" ] && args+=(-H "Cookie: $cookie")
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}" "$TUNNEL$path"
}
tun_headers() {
  local path="$1" cookie="${2:-}"
  local args=(-s -D - -o /dev/null)
  [ -n "$cookie" ] && args+=(-H "Cookie: $cookie")
  curl "${args[@]}" "$TUNNEL$path"
}

# ── 0. reachability ─────────────────────────────────────────────────────────────
step "0. The dashboard is up"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/api/health" || true)
if [ "$code" != "200" ]; then
  red "  $BASE/api/health returned '$code' — is the dashboard running? (hooop dashboard restart)"
  exit 1
fi
ok "health 200"

if [ ! -r "$TOKEN_FILE" ]; then
  red "  no install token at $TOKEN_FILE (set HOOOP_DASHBOARD_TOKEN_FILE)"
  exit 1
fi
TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
is "host can read the session list" "$(host_code GET /api/sessions)" "200"

# ── 1. a live session to pair into ──────────────────────────────────────────────
step "1. A live session"
SESSION_ID=$(host POST /api/sessions/new '{"label":"e2e-pairing","name":"e2e"}' | jq -r '.sessionId // empty')
if [ -z "$SESSION_ID" ]; then bad "created a session"; exit 1; fi
ok "created session $SESSION_ID"

# ── 2. the tunnel ───────────────────────────────────────────────────────────────
step "2. The tunnel"
t=$(host GET /api/tunnel)
if [ "$(printf '%s' "$t" | jq -r .status)" != "running" ]; then
  dim "  starting a tunnel (this takes a few seconds)…"
  t=$(host POST /api/tunnel)
  STARTED_TUNNEL=1
fi
TUNNEL=$(printf '%s' "$t" | jq -r '.url // empty')
if [ -z "$TUNNEL" ]; then bad "tunnel is running" "$(printf '%s' "$t" | head -c 200)"; exit 1; fi
ok "tunnel at $TUNNEL"

# ── 3. enrolling one of your own devices ────────────────────────────────────────
step "3. Add a device (the QR ceremony, as the phone would do it)"
mint=$(host POST /api/host-device/code "{\"publicBaseUrl\":\"$TUNNEL\",\"sessionId\":\"$SESSION_ID\"}")
CODE=$(printf '%s' "$mint" | jq -r '.code // empty')
if [ -z "$CODE" ]; then bad "minted an enrollment code" "$(printf '%s' "$mint" | head -c 200)"; exit 1; fi
ok "minted a code ($CODE), expiring $(printf '%s' "$mint" | jq -r '.expiresAt')"
has "the enrollment link points at the tunnel, code in the FRAGMENT" \
    "$(printf '%s' "$mint" | jq -r .link)" "/enroll#c="

enroll=$(curl -s -D "$JAR_DIR/dev.h" -H "Origin: $TUNNEL" -H "Content-Type: application/json" \
  -d "{\"code\":\"$CODE\",\"label\":\"e2e-phone\"}" "$TUNNEL/api/host-device/enroll")
DEV_COOKIE="hooop_host_device=$(grep -io 'hooop_host_device=[^;]*' "$JAR_DIR/dev.h" | head -1 | cut -d= -f2-)"
is "the phone is enrolled" "$(printf '%s' "$enroll" | jq -r '.ok // "no"')" "true"
is "it is told WHICH session to land on (not the new-session form)" \
   "$(printf '%s' "$enroll" | jq -r '.sessionId // "null"')" "$SESSION_ID"
has "it was handed a device cookie" "$DEV_COOKIE" "hooop_host_device="
if grep -qi 'hooop_token=' "$JAR_DIR/dev.h"; then bad "the install token never leaves the machine"; else ok "the install token never leaves the machine"; fi

DEVICE_ID=$(host GET /api/host-device | jq -r '.devices[-1].deviceId // empty')
is "the host's device list shows it" "$(host GET /api/host-device | jq -r '.devices | length')" "1"
is "labelled by the phone" "$(host GET /api/host-device | jq -r '.devices[-1].label')" "e2e-phone"
if [ "$(host GET /api/host-device | jq -r '.devices[-1].lastSeenAt')" = "null" ]; then
  bad "last-seen is set (not 'not used yet' about a device that just walked in)"
else
  ok "last-seen is set (not 'not used yet' about a device that just walked in)"
fi

# ── 4. the device IS the host ───────────────────────────────────────────────────
step "4. The device is the host, not a guest"
is "reads the session list"          "$(tun_code GET /api/sessions "$DEV_COOKIE")" "200"
is "reads host-only routes"          "$(tun_code GET /api/host-device "$DEV_COOKIE")" "200"
is "sees every session the host sees, not one" \
   "$(tun GET /api/sessions "$DEV_COOKIE" | jq 'length')" "$(host GET /api/sessions | jq 'length')"
is "refused the all-sessions firehose (/api/stream is the install host's alone)" \
   "$(tun_code GET /api/stream "$DEV_COOKIE")" "403"
before=$(host GET /api/host-device | jq -r '.devices[-1].lastSeenAt')
sleep 1
tun_code GET "/api/events?limit=1" "$DEV_COOKIE" >/dev/null
after=$(host GET /api/host-device | jq -r '.devices[-1].lastSeenAt')
if [ "$after" -gt "$before" ] 2>/dev/null; then
  ok "last-seen advances on a PLAIN READ (the route never looks at the participant)"
else
  bad "last-seen advances on a plain read" "before=$before after=$after"
fi

# ── 5. re-scanning replaces, rather than accumulating ───────────────────────────
step "5. Re-enrolling the same browser supersedes its old device"
mint2=$(host POST /api/host-device/code "{\"publicBaseUrl\":\"$TUNNEL\"}")
CODE2=$(printf '%s' "$mint2" | jq -r .code)
curl -s -D "$JAR_DIR/dev2.h" -H "Origin: $TUNNEL" -H "Content-Type: application/json" \
  -H "Cookie: $DEV_COOKIE" \
  -d "{\"code\":\"$CODE2\",\"label\":\"e2e-phone\"}" "$TUNNEL/api/host-device/enroll" >/dev/null
DEV_COOKIE="hooop_host_device=$(grep -io 'hooop_host_device=[^;]*' "$JAR_DIR/dev2.h" | head -1 | cut -d= -f2-)"
DEVICE_ID=$(host GET /api/host-device | jq -r '.devices[-1].deviceId // empty')
is "still exactly one device, not two" "$(host GET /api/host-device | jq -r '.devices | length')" "1"

# ── 6. a guest, the ordinary way ────────────────────────────────────────────────
step "6. Invite a guest (share link, admit, claim)"
share=$(host POST /api/share "{\"sessionId\":\"$SESSION_ID\",\"publicBaseUrl\":\"$TUNNEL\",\"capability\":\"full\"}")
SHARE_ID=$(printf '%s' "$share" | jq -r '.shareId // empty')
LINK=$(printf '%s' "$share" | jq -r '.link // empty')
PEER_TOKEN="${LINK##*#k=}"
if [ -z "$SHARE_ID" ]; then bad "created a share" "$(printf '%s' "$share" | head -c 200)"; exit 1; fi
ok "share $SHARE_ID"

redeem=$(curl -s -D "$JAR_DIR/pend.h" -H "Origin: $TUNNEL" -H "Content-Type: application/json" \
  -d "{\"token\":\"$PEER_TOKEN\",\"name\":\"e2e-guest\"}" "$TUNNEL/api/share/redeem")
TICKET=$(printf '%s' "$redeem" | jq -r '.ticketId // empty')
PEND_COOKIE="hooop_pending=$(grep -io 'hooop_pending=[^;]*' "$JAR_DIR/pend.h" | head -1 | cut -d= -f2-)"
is "redeeming creates a PENDING join, not access" "$(printf '%s' "$redeem" | jq -r '.pending // "no"')" "true"
is "the host sees it waiting" \
   "$(host GET /api/share/pending-joins | jq --arg t "$TICKET" '[.joins[] | select(.ticketId==$t)] | length')" "1"
is "host admits" "$(host_code POST "/api/share/join/$TICKET/admit")" "200"

claim=$(curl -s -D "$JAR_DIR/peer.h" -H "Origin: $TUNNEL" -H "Content-Type: application/json" \
  -H "Cookie: $PEND_COOKIE" \
  -d "{\"token\":\"$PEER_TOKEN\",\"ticketId\":\"$TICKET\"}" "$TUNNEL/api/share/claim")
PEER_COOKIE="hooop_peer=$(grep -io 'hooop_peer=[^;]*' "$JAR_DIR/peer.h" | head -1 | cut -d= -f2-)"
is "claim issues the peer cookie" "$(printf '%s' "$claim" | jq -r '.ok // "no"')" "true"
is "the guest reads their session"  "$(tun_code GET /api/sessions "$PEER_COOKIE")" "200"
is "the guest is NOT the host"      "$(tun_code GET /api/host-device "$PEER_COOKIE")" "403"
is "the guest cannot open the firehose" "$(tun_code GET /api/stream "$PEER_COOKIE")" "403"
is "the guest sees only their own session" "$(tun GET /api/sessions "$PEER_COOKIE" | jq 'length')" "1"

# ── 7. THE REPORTED BUG ─────────────────────────────────────────────────────────
step "7. Revoke the device while the same browser also holds a live share"
is "revoke" "$(host_code POST "/api/host-device/$DEVICE_ID/revoke")" "200"
sleep 4  # the access check caches a verdict for ~3s

is "the revoked device alone is refused" "$(tun_code GET /api/sessions "$DEV_COOKIE")" "403"
has "and told it was the DEVICE" "$(tun GET /api/sessions "$DEV_COOKIE")" "device revoked"

BOTH="$DEV_COOKIE; $PEER_COOKIE"
is "BOTH cookies: the live share still works (the shadowing bug)" "$(tun_code GET /api/sessions "$BOTH")" "200"
is "BOTH cookies: served as the guest, not refused as a dead device" \
   "$(tun_code GET /api/host-device "$BOTH")" "403"
has "BOTH cookies: the dead device cookie is cleared on the way out" \
    "$(tun_headers /api/sessions "$BOTH")" "hooop_host_device=;"
DEVICE_ID=""  # already revoked; don't try again in cleanup

# ── 8. the tunnel is not an app you can just open ───────────────────────────────
step "8. What the public sees"
h=$(tun_headers "/")
has "a page request with no credential is sent to the signed-out page" "$h" "/left"
is "the signed-out page itself renders"  "$(tun_code GET /left)" "200"
is "the join page renders (pre-credential)"   "$(tun_code GET /join/x)" "200"
is "the enroll page renders (pre-credential)" "$(tun_code GET /enroll)" "200"
for a in /icon.svg /manifest.webmanifest /sw.js; do
  is "public asset served cookieless: $a" "$(tun_code GET "$a")" "200"
done
is "an api request with no credential is refused" "$(tun_code GET /api/sessions)" "403"

# ── 9. revoking the guest ───────────────────────────────────────────────────────
step "9. Revoke the guest"
is "revoke" "$(host_code POST "/api/share/$SHARE_ID/revoke")" "200"
SHARE_ID=""
sleep 4
is "the guest can no longer read" "$(tun_code GET /api/sessions "$PEER_COOKIE")" "403"
is "…including routes that never had their own guard (/api/files)" \
   "$(tun_code GET "/api/files?sessionId=$SESSION_ID" "$PEER_COOKIE")" "403"
is "…and /api/previews"  "$(tun_code GET /api/previews "$PEER_COOKIE")" "403"
is "…and /api/skills"    "$(tun_code GET /api/skills "$PEER_COOKIE")" "403"
is "…and /api/agents"    "$(tun_code GET /api/agents "$PEER_COOKIE")" "403"
