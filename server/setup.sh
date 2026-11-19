#!/usr/bin/env bash
# Sets up a private AI server for the browser on a fresh Ubuntu VM (made for Oracle Cloud's
# free Ampere A1 machine): Ollama with an open model, behind Caddy for HTTPS + an access token.
#
#   curl -fsSL <raw link to this file> | sudo bash          # or: sudo bash setup.sh
#   sudo MODEL=gemma3:4b bash setup.sh                     # pick another model
#
# Safe to run again (keeps the same access token). Prints the three values to paste into
# the browser's Settings → Your own AI server.
set -euo pipefail

MODEL="${MODEL:-llama3.2:3b}"
CONTEXT="${CONTEXT:-16384}"
STATE=/etc/browser-ai

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

echo "==> Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl gpg openssl iptables-persistent debian-keyring debian-archive-keyring apt-transport-https

echo "==> Installing Ollama"
if ! command -v ollama >/dev/null; then
  curl -fsSL https://ollama.com/install.sh | sh
fi
# Only reachable from this machine; Caddy is the public door
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/browser.conf <<EOF
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_CONTEXT_LENGTH=${CONTEXT}"
Environment="OLLAMA_KEEP_ALIVE=24h"
Environment="OLLAMA_NUM_PARALLEL=1"
EOF
systemctl daemon-reload
systemctl enable --now ollama
systemctl restart ollama
for _ in $(seq 30); do curl -fs http://127.0.0.1:11434/ >/dev/null && break; sleep 1; done

echo "==> Downloading ${MODEL} (a few minutes)"
ollama pull "$MODEL"

echo "==> Installing Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

mkdir -p "$STATE"
chmod 700 "$STATE"
[[ -s $STATE/token ]] || openssl rand -hex 24 > "$STATE/token"
TOKEN="$(cat "$STATE/token")"

# Free HTTPS name for the public IP: 1.2.3.4 → 1-2-3-4.sslip.io
IP="$(curl -fs https://api.ipify.org)"
DOMAIN="${DOMAIN:-${IP//./-}.sslip.io}"

cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	@authed header Authorization "Bearer ${TOKEN}"
	handle @authed {
		reverse_proxy 127.0.0.1:11434
	}
	handle {
		respond "Unauthorized" 401
	}
}
EOF
chmod 640 /etc/caddy/Caddyfile
chown root:caddy /etc/caddy/Caddyfile

echo "==> Opening ports 80 and 443 in the VM firewall"
# Oracle's Ubuntu images reject everything except SSH by default
iptables -C INPUT -p tcp -m multiport --dports 80,443 -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null \
  || iptables -I INPUT 1 -p tcp -m multiport --dports 80,443 -m conntrack --ctstate NEW -j ACCEPT
netfilter-persistent save >/dev/null

systemctl enable caddy
systemctl restart caddy

echo "==> Checking https://${DOMAIN} (getting the certificate can take a minute)"
ok=""
for _ in $(seq 24); do
  if curl -fs -o /dev/null -H "Authorization: Bearer ${TOKEN}" "https://${DOMAIN}/v1/models"; then ok=1; break; fi
  sleep 5
done

echo
if [[ -n $ok ]]; then
  echo "Your AI server is ready. In the browser: Settings (⌘,) → Your own AI server"
else
  echo "Set up, but https://${DOMAIN} isn't answering yet. Most likely ports 80/443 aren't open in"
  echo "Oracle's console (Networking → your VCN → Security List → add ingress rules for TCP 80 and 443)."
  echo "Once they are, it starts working by itself — no need to rerun. Then in the browser:"
fi
echo
echo "  Server address:  https://${DOMAIN}"
echo "  Model:           ${MODEL}"
echo "  Access token:    ${TOKEN}"
echo
