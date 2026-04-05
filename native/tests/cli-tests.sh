#!/bin/bash
cd "$(dirname "$0")/.."

PASS=0
FAIL=0

test_output() {
  local name="$1"
  local cmd="$2"
  local expect="$3"
  
  output=$(eval "$cmd" 2>&1) || true
  if echo "$output" | grep -q "$expect"; then
    echo "PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name"
    echo "  Command: $cmd"
    echo "  Expected: $expect"
    echo "  Got: $output"
    FAIL=$((FAIL + 1))
  fi
}

test_exit_code() {
  local name="$1"
  local cmd="$2"
  local expect_code="$3"
  
  eval "$cmd" > /dev/null 2>&1
  actual_code=$?
  if [ "$actual_code" -eq "$expect_code" ]; then
    echo "PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name"
    echo "  Command: $cmd"
    echo "  Expected exit code: $expect_code"
    echo "  Got: $actual_code"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== CLI Unit Tests (no extension required) ==="
echo ""

echo "-- Version and Help --"
test_output "version flag" "node cli.cjs --version" "surf version"
test_output "version short" "node cli.cjs -v" "surf version"
test_output "basic help" "node cli.cjs --help" "Common Commands"
test_output "full help" "node cli.cjs --help-full" "Aliases:"
test_output "help topic refs" "node cli.cjs --help-topic refs" "Element References"
test_output "help topic selectors" "node cli.cjs --help-topic selectors" "CSS Selectors"
test_output "help topic cookies" "node cli.cjs --help-topic cookies" "Cookie Management"

echo ""
echo "-- Migration Hints --"
test_output "removed read_page" "node cli.cjs read_page" "Use: page.read"
test_output "removed list_tabs" "node cli.cjs list_tabs" "Use: tab.list"
test_output "removed wait_for_element" "node cli.cjs wait_for_element" "Use: wait.element"
test_output "removed javascript_tool" "node cli.cjs javascript_tool" "Use: js"

echo ""
echo "-- Aliases --"
test_output "snap help" "node cli.cjs snap --help" "snap -> screenshot"
test_output "read help" "node cli.cjs read --help" "accessibility tree"
test_output "find help" "node cli.cjs find --help" "search"
test_output "go help" "node cli.cjs go --help" "URL"

echo ""
echo "-- Find Command --"
test_output "find screenshot" "node cli.cjs --find screenshot" "screenshot"
test_output "find cookie" "node cli.cjs --find cookie" "cookie"
test_output "find wait" "node cli.cjs --find wait" "wait"

echo ""
echo "-- About Command --"
test_output "about refs" "node cli.cjs --about refs" "Element References"
test_output "about cookies" "node cli.cjs --about cookies" "Cookie Management"
test_output "about tab" "node cli.cjs --about tab" "Tab management"

echo ""
echo "-- Group Help --"
test_output "tab group help" "node cli.cjs tab" "tab.list"
test_output "cookie group help" "node cli.cjs cookie" "cookie.list"
test_output "scroll group help" "node cli.cjs scroll" "scroll.top"

echo ""
echo "-- Command Help with Examples --"
test_output "click help examples" "node cli.cjs click --help" "Examples"
test_output "type help examples" "node cli.cjs type --help" "Examples"
test_output "screenshot help examples" "node cli.cjs screenshot --help" "Examples"
test_output "chatgpt.chats help" "node cli.cjs chatgpt.chats --help" "Search conversations"
test_output "chatgpt.reply help" "node cli.cjs chatgpt.reply --help" "Reply in-thread"

echo ""
echo "-- New Commands in Help --"
test_output "back in help" "node cli.cjs --help-full" "back"
test_output "forward in help" "node cli.cjs --help-full" "forward"
test_output "zoom in help" "node cli.cjs --help-full" "zoom"
test_output "bookmark in help" "node cli.cjs --help-full" "bookmark"
test_output "history in help" "node cli.cjs --help-full" "history"

echo ""
echo "-- ChatGPT Chats Validation --"
test_output "chatgpt.chats cloak hint" "node cli.cjs chatgpt.chats" "requires CloakBrowser mode"
test_output "chatgpt.chats invalid combo" "SURF_USE_CLOAK_CHATGPT=1 node cli.cjs chatgpt.chats abc --search test" "cannot use conversation ID with --search"
test_output "chatgpt.chats all+limit invalid" "SURF_USE_CLOAK_CHATGPT=1 node cli.cjs chatgpt.chats --all --limit 5" "cannot be combined with --limit"
test_output "chatgpt.chats advanced conflict" "SURF_USE_CLOAK_CHATGPT=1 node cli.cjs chatgpt.chats abc --rename 'New Title' --delete" "use only one of --rename, --delete, --delete-ids, or --download-file"
test_output "chatgpt.chats download requires output" "SURF_USE_CLOAK_CHATGPT=1 node cli.cjs chatgpt.chats abc --download-file file-123" "requires --output"
test_output "chatgpt.reply usage" "SURF_USE_CLOAK_CHATGPT=1 node cli.cjs chatgpt.reply" "Usage: surf chatgpt.reply"

echo ""
echo "-- Session Reconcile --"
tmp_sessions=$(mktemp -d)
test_output "session reconcile empty" \
  "SURF_SESSIONS_DIR=$tmp_sessions node cli.cjs session --reconcile" \
  "No running sessions"
test_output "session clear+reconcile invalid" \
  "node cli.cjs session --clear --reconcile" \
  "cannot combine --clear with --reconcile"
# stale session: dead pid, old createdAt
mkdir -p "$tmp_sessions/chatgpt-stale_2000-01-01_000000.000_0001"
cat > "$tmp_sessions/chatgpt-stale_2000-01-01_000000.000_0001/meta.json" <<'METAMETA'
{"id":"chatgpt-stale_2000-01-01_000000.000_0001","tool":"chatgpt","status":"running","createdAt":"2000-01-01T00:00:00.000Z","pid":999999999,"conversationId":null,"reconcile":null}
METAMETA
test_output "session list shows orphaned" \
  "SURF_SESSIONS_DIR=$tmp_sessions node cli.cjs session --all" \
  "orphaned"
# alive pid but very old → stale, NOT orphaned
mkdir -p "$tmp_sessions/chatgpt-alive-but-old_2000-01-01_000000.000_0002"
cat > "$tmp_sessions/chatgpt-alive-but-old_2000-01-01_000000.000_0002/meta.json" <<'METAMETA'
{"id":"chatgpt-alive-but-old_2000-01-01_000000.000_0002","tool":"chatgpt","status":"running","createdAt":"2000-01-01T00:00:00.000Z","pid":$$,"conversationId":null,"reconcile":null}
METAMETA
test_output "session list shows stale not orphaned" \
  "SURF_SESSIONS_DIR=$tmp_sessions node cli.cjs session --all" \
  "stale"
rm -rf "$tmp_sessions"

echo ""
echo "-- List Command --"
test_output "list shows new commands" "node cli.cjs --list" "back"
test_output "list shows zoom" "node cli.cjs --list" "zoom"

echo ""
echo "==================================="
echo "Results: $PASS passed, $FAIL failed"
echo "==================================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
