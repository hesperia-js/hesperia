#!/usr/bin/env bash
set -euo pipefail

source_file=/etc/apt/sources.list.d/microsoft-prod.list
disabled_file=$source_file.hesperia-playwright.disabled
vendor_entry='deb [arch=amd64,arm64,armhf signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/ubuntu/24.04/prod noble main'

if [[ ${RUNNER_ENVIRONMENT:-} != github-hosted ]]; then
  exec node node_modules/playwright/cli.js install --with-deps "$@"
fi

if [[ -e $disabled_file || -L $disabled_file ]]; then
  echo "A previous Playwright setup left the Microsoft apt source at $disabled_file" >&2
  exit 1
fi

if [[ ! -f $source_file || -L $source_file ]] || ! cmp -s -- "$source_file" <(printf '%s\n' "$vendor_entry"); then
  exec node node_modules/playwright/cli.js install --with-deps "$@"
fi

# Playwright's dependency install updates all configured apt feeds. Restore the
# runner's source before downloading browsers or entering another setup step.
(
  restore_source() {
    if [[ -e $disabled_file ]]; then
      sudo -n mv -T -n -- "$disabled_file" "$source_file"

      if [[ -e $disabled_file ]]; then
        echo "Could not restore Microsoft apt source from $disabled_file" >&2
        exit 1
      fi
    fi
  }

  trap restore_source EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  sudo -n mv -T -n -- "$source_file" "$disabled_file"
  [[ ! -e $source_file && ! -L $source_file ]]
  echo 'Installing Playwright dependencies without the runner Microsoft Noble production feed'
  node node_modules/playwright/cli.js install-deps "$@"
)

exec node node_modules/playwright/cli.js install "$@"
