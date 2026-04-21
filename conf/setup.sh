#!/bin/bash

set -euo pipefail

# --- HARDWARE PERMISSIONS ---
# If this service requires hardware access, you likely need a udev rule
# to assign ownership to the 'paws' user.
# Example: /etc/udev/rules.d/99-paws.rules
# SUBSYSTEM=="usb", ATTRS{idVendor}=="XXXX", OWNER="paws"
# ----------------------------

echo "Linking sysusers config..."

mkdir -p /etc/sysusers.d

if [ -f /etc/sysusers.d/paws.conf ]; then
    rm /etc/sysusers.d/paws.conf
fi

ln -s "/var/p.wskr.sh/conf/paws.conf" /etc/sysusers.d/paws.conf

echo "Creating user..."

systemd-sysusers

echo "Linking unit..."

if [ -f /etc/systemd/system/paws.service ]; then
    rm /etc/systemd/system/paws.service
fi

systemctl link "/var/p.wskr.sh/conf/paws.service"

if command -v logrotate >/dev/null 2>&1; then
    echo "Linking logrotate config..."

    if [ -f /etc/logrotate.d/paws ]; then
        rm /etc/logrotate.d/paws
    fi

    ln -s "/var/p.wskr.sh/conf/paws_logs.conf" /etc/logrotate.d/paws
else
    echo "Logrotate not found, skipping..."
fi

echo "Reloading daemon..."

systemctl daemon-reload
systemctl enable paws

echo "Fixing initial permissions..."

mkdir -p "/var/p.wskr.sh/logs"

chown -R paws:paws "/var/p.wskr.sh"

find "/var/p.wskr.sh" -type d -exec chmod 755 {} +
find "/var/p.wskr.sh" -type f -exec chmod 644 {} +

chmod +x "/var/p.wskr.sh/paws"

echo "Setup complete, starting service..."

service paws restart

echo "Done."
