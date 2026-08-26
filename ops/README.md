# Optional VM helper

`setup-windows-share.sh` is not required to build, run, deploy, or administer
Avalon. It configures Samba and Windows network discovery so this particular
VM's workspace can be edited from a trusted Windows machine on the physical
LAN.

The script is intentionally machine-specific. Before running it, review and
change its hard-coded assumptions:

- Linux user and shared path: `xie` and `/home/xie`;
- physical interface: `enp6s18`;
- allowed LAN: `10.0.0.0/24`;
- displayed Windows path/IP: `\\10.0.0.228\xie`.

It runs as root, installs packages, replaces `/etc/samba/smb.conf` after making
a timestamped backup, changes Samba/WSD service state, creates an SMB password,
and may add UFW rules for ports 445, 3702, and 5357. Run it only on the intended
host after verifying those values and the LAN trust boundary.
