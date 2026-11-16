#!/usr/bin/env bash
# Runs the real Magpie CLI against a throwaway home: plugin add -> connect -> disconnect -> remove,
# and proves the live Magpie + Codex setup is unchanged. Git Bash on Windows.
#   bash verify/magpie-sandbox.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$(cygpath -m "$here/../packages/pi-desktop")"
M="${MAGPIE:-magpie}"
BUN="${MAGPIE_BUN:-$HOME/.cache/magpie/bun/1.4.4/magpie-bun.exe}"
sb="$(cygpath -m "$(mktemp -d "${TEMP:-/tmp}/magpie-sandbox-XXXXXX")")"
mkdir -p "$sb/.pi-desktop" "$sb/AppData/Roaming" "$sb/AppData/Local"   # Pi-Desktop "installed" in the sandbox

m() {
  env USERPROFILE="$sb" HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" \
    APPDATA="$sb/AppData/Roaming" LOCALAPPDATA="$sb/AppData/Local" \
    MAGPIE_ADDR=127.0.0.1:3499 MAGPIE_BUN="$BUN" MAGPIE_NO_HANDOVER=1 MAGPIE_NO_INSTALL=1 \
    MAGPIE_NO_SHORTCUT=1 MAGPIE_NO_ACCOUNTS=1 "$M" "$@" 2>&1
}
bridge="$sb/.config/magpie-pi-desktop/connection.json"
fails=0
check() { if eval "$2"; then echo "ok    $1"; else echo "FAIL  $1"; fails=$((fails+1)); fi; }

node "$here/codex-invariants.mjs" snapshot "$sb/live-before.json" >/dev/null
procs_before=$(tasklist.exe //FO CSV 2>/dev/null | grep -ci magpie)

# Seen with Magpie 0.1.2404 on Windows: while the live Magpie app runs, the CLI with another
# USERPROFILE prints nothing, writes nothing and exits 0. Don't stop the live app for this test.
if [ -z "$(m --help | head -1)" ]; then
  echo "SKIP  the sandboxed Magpie CLI prints nothing while the live Magpie app is running;"
  echo "      quit Magpie (Codex loses its gateway meanwhile) and run this again, or use the live steps in docs/03"
  echo "sandbox: $sb"; exit 3
fi

echo "== plugin add $pkg"; m plugin add "$pkg" | tail -5
echo "== plugin list"; m plugin list | tail -8
echo "== ls"; ls_out="$(m ls)"; echo "$ls_out" | grep -i "pi-desktop\|Pi-Desktop"
check "Magpie lists a Pi-Desktop row" 'echo "$ls_out" | grep -q "Pi-Desktop"'

echo "== pi-desktop-app provider magpie"; m pi-desktop-app provider magpie | tail -5
check "connect wrote the bridge file" '[ -f "$bridge" ]'
[ -f "$bridge" ] && node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).magpie||{}; console.log("bridge:", JSON.stringify({...b, models: (b.models||[]).length}))' "$bridge"
check "bridge points at the sandbox gateway with Pi-Desktop's key" \
  'node -e "const b=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).magpie; process.exit(b && b.baseUrl===\"http://127.0.0.1:3499/v1\" && b.apiKey===\"magpie-pi-desktop-app\" && b.apiStyle===\"chat_completions\" ? 0 : 1)" "$bridge"'
echo "== pi-desktop-app"; m pi-desktop-app | tail -3
(cd "$here/../packages/pi-desktop" && MAGPIE_PI_DESKTOP_BRIDGE="$bridge" node scripts/pack.mjs --out "$sb/dist") | sed 's/^/pack: /'
check "pack.mjs took the base URL from the bridge" 'grep -q "127.0.0.1:3499/v1" "$sb/dist/"*.piplug'

echo "== pi-desktop-app default"; m pi-desktop-app default | tail -3
check "disconnect removed the magpie block" \
  '[ ! -f "$bridge" ] || node -e "process.exit(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")||\"{}\").magpie===undefined?0:1)" "$bridge"'
[ -f "$bridge" ] && echo "bridge after disconnect: $(cat "$bridge")"

name="$(m plugin list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const l=Array.isArray(j)?j:j.plugins||[];const p=l.find(x=>/pi-desktop/.test(JSON.stringify(x)));console.log(p?.name||p?.spec||p?.id||"")}catch{console.log("")}})')"
echo "== plugin rm ${name:-pi-desktop}"; m plugin rm "${name:-pi-desktop}" | tail -3
check "plugin removed from the sandbox" '! m plugin list | grep -qi "pi-desktop"'

sleep 2
procs_after=$(tasklist.exe //FO CSV 2>/dev/null | grep -ci magpie)
check "no Magpie process left behind ($procs_before before, $procs_after after)" '[ "$procs_after" -le "$procs_before" ]'
node "$here/codex-invariants.mjs" snapshot "$sb/live-after.json" >/dev/null
check "nothing left listening on the sandbox port 3499" '! netstat -ano 2>/dev/null | grep -q "127.0.0.1:3499 .*LISTENING"'
echo "== live Magpie + Codex"; node "$here/codex-invariants.mjs" compare "$sb/live-before.json" "$sb/live-after.json"; live=$?
check "live Magpie + Codex unchanged" '[ $live -eq 0 ]'
echo; echo "sandbox: $sb"; [ $fails -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
