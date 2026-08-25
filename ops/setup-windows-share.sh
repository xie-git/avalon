#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  exec sudo -- "$0" "$@"
fi

share_user="xie"
share_path="/home/xie"
lan_interface="enp6s18"
lan_cidr="10.0.0.0/24"
smb_config="/etc/samba/smb.conf"

if ! id "$share_user" >/dev/null 2>&1; then
  echo "Required user '$share_user' does not exist." >&2
  exit 1
fi

if [[ ! -d "/sys/class/net/$lan_interface" ]]; then
  echo "Required LAN interface '$lan_interface' does not exist." >&2
  exit 1
fi

echo "Installing Samba and Windows network discovery..."
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y samba smbclient wsdd-server

if [[ -e "$smb_config" ]]; then
  backup_path="${smb_config}.before-windows-share.$(date -u +%Y%m%dT%H%M%SZ)"
  cp -a -- "$smb_config" "$backup_path"
  echo "Saved the previous Samba configuration as $backup_path"
fi

install -d -m 0755 /etc/samba
cat >"$smb_config" <<'EOF'
[global]
   workgroup = WORKGROUP
   server string = Avalon Xie VM
   security = user
   map to guest = Never
   server min protocol = SMB2
   smb ports = 445
   disable netbios = yes
   interfaces = lo enp6s18
   bind interfaces only = yes
   hosts allow = 127. 10.0.0.0/24
   hosts deny = 0.0.0.0/0
   log file = /var/log/samba/log.%m
   max log size = 1000
   logging = file

[xie]
   path = /home/xie
   browseable = yes
   read only = no
   valid users = xie
   force user = xie
   create mask = 0644
   directory mask = 0755
   hide unreadable = yes
EOF

cat >/etc/default/wsdd <<'EOF'
# Announce only on the physical LAN, not Tailscale or Docker networks.
WSDD_PARAMS="--interface enp6s18"
EOF

testparm -s "$smb_config" >/dev/null

echo
echo "Choose the password you will use from Windows for the SMB user '$share_user'."
while true; do
  read -r -s -p "SMB password: " smb_password
  echo
  read -r -s -p "Confirm SMB password: " smb_password_confirm
  echo
  if [[ -n "$smb_password" && "$smb_password" == "$smb_password_confirm" ]]; then
    break
  fi
  echo "Passwords were empty or did not match; try again."
done

printf '%s\n%s\n' "$smb_password" "$smb_password" | smbpasswd -s -a "$share_user"
unset smb_password smb_password_confirm

systemctl disable --now nmbd 2>/dev/null || true
systemctl enable --now smbd wsdd-server
systemctl restart smbd wsdd-server

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow in on "$lan_interface" from "$lan_cidr" to any port 445 proto tcp comment 'LAN Samba'
  ufw allow in on "$lan_interface" from "$lan_cidr" to any port 3702 proto udp comment 'LAN WSD discovery'
  ufw allow in on "$lan_interface" from "$lan_cidr" to any port 5357 proto tcp comment 'LAN WSD metadata'
fi

echo
echo "Service state:"
systemctl --no-pager --quiet is-active smbd wsdd-server
systemctl --no-pager is-active smbd wsdd-server
echo
echo "Listening ports:"
ss -lntup | grep -E ':(445|3702|5357)([[:space:]]|$)' || true
echo
echo "Share configuration:"
testparm -s "$smb_config" 2>/dev/null | sed -n '/^\[xie\]/,/^$/p'
echo
echo "Setup complete. From Windows, open: \\\\10.0.0.228\\xie"
