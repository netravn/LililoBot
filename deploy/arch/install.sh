#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Install the Lililo bot and NapCat systemd units on Arch Linux.

Usage:
  sudo ./deploy/arch/install.sh --user USER --qq QQ_NUMBER [options]

Options:
  --user USER          Linux account used to run QQ and the bot
  --qq QQ_NUMBER       QQ account used by NapCat quick login
  --project-dir PATH   Project directory (default: detected automatically)
  --start              Enable and start both services after installation
  -h, --help           Show this help

NapCat and Linux QQ must be installed before starting napcat.service.
The script does not download or patch QQ/NapCat and never overwrites config.json
or /etc/lililo-bot.env.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
project_dir=$(cd -- "${script_dir}/../.." && pwd)
bot_user=""
qq_number=""
start_services=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      [[ $# -ge 2 ]] || die "--user requires a value"
      bot_user=$2
      shift 2
      ;;
    --qq)
      [[ $# -ge 2 ]] || die "--qq requires a value"
      qq_number=$2
      shift 2
      ;;
    --project-dir)
      [[ $# -ge 2 ]] || die "--project-dir requires a value"
      project_dir=$(realpath -- "$2")
      shift 2
      ;;
    --start)
      start_services=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[[ ${EUID} -eq 0 ]] || die "run this installer with sudo"
[[ -f /etc/arch-release ]] || die "this deployment script only supports Arch Linux"
[[ -n ${bot_user} ]] || die "--user is required"
[[ ${qq_number} =~ ^[0-9]+$ ]] || die "--qq must contain digits only"
[[ ${project_dir} != *[[:space:]]* ]] || die "project path must not contain whitespace"
[[ -f ${project_dir}/package.json ]] || die "package.json not found in ${project_dir}"
[[ -f ${project_dir}/src/index.js ]] || die "src/index.js not found in ${project_dir}"
id "${bot_user}" >/dev/null 2>&1 || die "Linux user does not exist: ${bot_user}"

bot_group=$(id -gn "${bot_user}")
bot_home=$(getent passwd "${bot_user}" | cut -d: -f6)
[[ -n ${bot_home} && -d ${bot_home} ]] || die "home directory not found for ${bot_user}"

echo "Installing Arch dependencies..."
pacman -S --needed --noconfirm nodejs npm xorg-server-xvfb

echo "Installing production Node.js dependencies..."
runuser -u "${bot_user}" -- npm --prefix "${project_dir}" ci --omit=dev
install -d -o "${bot_user}" -g "${bot_group}" "${project_dir}/data/sessions"

if [[ ! -f ${project_dir}/config.json ]]; then
  install -o "${bot_user}" -g "${bot_group}" -m 600 \
    "${project_dir}/config.example.json" "${project_dir}/config.json"
  echo "Created ${project_dir}/config.json"
else
  echo "Keeping existing ${project_dir}/config.json"
fi

render_unit() {
  local source=$1
  local target=$2
  local content
  content=$(<"${source}")
  content=${content//@PROJECT_DIR@/${project_dir}}
  content=${content//@BOT_USER@/${bot_user}}
  content=${content//@BOT_GROUP@/${bot_group}}
  content=${content//@BOT_HOME@/${bot_home}}
  content=${content//@QQ_NUMBER@/${qq_number}}
  printf '%s\n' "${content}" >"${target}"
  chmod 644 "${target}"
}

render_unit "${script_dir}/lililo-bot.service" /etc/systemd/system/lililo-bot.service
render_unit "${script_dir}/napcat.service" /etc/systemd/system/napcat.service

if [[ ! -f /etc/lililo-bot.env ]]; then
  env_content=$(<"${script_dir}/lililo-bot.env.example")
  env_content=${env_content//@PROJECT_DIR@/${project_dir}}
  printf '%s\n' "${env_content}" >/etc/lililo-bot.env
  chmod 600 /etc/lililo-bot.env
  echo "Created /etc/lililo-bot.env"
else
  echo "Keeping existing /etc/lililo-bot.env"
fi

systemctl daemon-reload

if ! command -v qq >/dev/null 2>&1; then
  echo "warning: /usr/bin/qq is missing; install Linux QQ before starting NapCat" >&2
fi
if [[ ! -f /opt/QQ/resources/app/napcat/napcat.mjs ]]; then
  echo "warning: NapCat was not detected at the standard QQ path" >&2
  echo "         install NapCat before starting napcat.service" >&2
fi

if [[ ${start_services} == true ]]; then
  grep -q 'replace-me\|replace-with-a-long-random-token' /etc/lililo-bot.env && \
    die "edit /etc/lililo-bot.env before using --start"
  command -v qq >/dev/null 2>&1 || die "Linux QQ is not installed"
  systemctl enable --now lililo-bot.service
  systemctl enable --now napcat.service
  echo "Services enabled and started. Run: journalctl -u napcat -f"
else
  echo
  echo "Installation complete. Next:"
  echo "  1. Edit ${project_dir}/config.json and /etc/lililo-bot.env"
  echo "  2. Install/configure NapCat, including its reverse WebSocket client"
  echo "  3. sudo systemctl enable --now lililo-bot napcat"
fi
