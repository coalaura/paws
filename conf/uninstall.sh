#!/bin/bash

set -euo pipefail

echo "Stopping service..."
systemctl stop "paws" 2>/dev/null || true

echo "Disabling service..."
systemctl disable "paws" 2>/dev/null || true

echo "Removing unit file..."
rm -f "/etc/systemd/system/paws.service"

echo "Removing sysusers config..."
rm -f "/etc/sysusers.d/paws.conf"

if [ -f "/etc/logrotate.d/paws" ]; then
    echo "Removing logrotate config..."
    rm -f "/etc/logrotate.d/paws"
fi

echo "Reloading daemon..."
systemctl daemon-reload
systemctl reset-failed "paws" 2>/dev/null || true

echo "Removing user and group..."
if id "paws" &>/dev/null; then
    userdel "paws" 2>/dev/null || true
fi

if getent group "paws" &>/dev/null; then
    groupdel "paws" 2>/dev/null || true
fi

echo "Uninstall complete."
