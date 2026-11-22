#!/usr/bin/env bash
# Create a self-signed certificate for LAN testing.
#   ./deploy/make-lan-cert.sh 192.168.5.139
# Then run:
#   ./dist/kzblackx-audio-linux-amd64 --addr 0.0.0.0:8443 \
#     --tls-cert lan-cert/lan.crt --tls-key lan-cert/lan.key \
#     --udp-port 3478 --password '...'
set -euo pipefail

IP=${1:-$(hostname -I 2>/dev/null | awk '{print $1}')}
OUT=${2:-./lan-cert}
if [[ -z "$IP" ]]; then
  echo "用法: $0 <局域网IP> [输出目录]" >&2
  exit 1
fi
mkdir -p "$OUT"
chmod 700 "$OUT"

HOST=$(hostname 2>/dev/null || echo kzblackx-audio)
openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
  -keyout "$OUT/lan.key" -out "$OUT/lan.crt" \
  -subj "/CN=KzBlackX LAN ($IP)" \
  -addext "subjectAltName=IP:$IP,IP:127.0.0.1,DNS:localhost,DNS:$HOST" 2>/dev/null
chmod 600 "$OUT/lan.key"

cat <<MSG

证书已生成：
  $OUT/lan.crt
  $OUT/lan.key

启动示例：
  ./dist/kzblackx-audio-linux-amd64 --addr 0.0.0.0:8443 --udp-port 3478 \\
    --tls-cert $OUT/lan.crt --tls-key $OUT/lan.key --password '换成你的密码'

在手机/电脑浏览器打开：
  https://$IP:8443

首次会提示证书不受信任，选择「高级 / 继续前往」；只有这样才能用麦克风
（普通 http:// 不是安全上下文，浏览器会拒绝麦克风）。
MSG
