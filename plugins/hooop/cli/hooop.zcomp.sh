_hooop() {
  local src opts
  src="${HOOOP_PATH}/hooop"
  opts=$("$src" shortlist "${(@)words[2,$((CURRENT-1))]}" 2>/dev/null)
  case "$opts" in
    __file__) _files ;;
    __dir__)  _files -/ ;;
    *)        [[ -n "$opts" ]] && compadd -- ${=opts} ;;
  esac
}
compdef _hooop hooop
