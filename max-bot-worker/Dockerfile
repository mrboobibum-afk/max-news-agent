FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip openssl \
    && rm -rf /var/lib/apt/lists/*

# MAX API uses the Russian Trusted CA chain.
# Download only from the official government certificate host.
RUN set -eux; \
    curl -kfsSL https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt \
      -o /usr/local/share/ca-certificates/russian_trusted_root_ca.crt; \
    curl -kfsSL https://gu-st.ru/content/lending/russian_trusted_sub_ca.zip \
      -o /tmp/russian_trusted_sub_ca.zip; \
    mkdir -p /tmp/max-ca; \
    unzip -q /tmp/russian_trusted_sub_ca.zip -d /tmp/max-ca; \
    for f in $(find /tmp/max-ca -type f \( -name '*.crt' -o -name '*.cer' \)); do \
      name=$(basename "$f" | tr ' ' '_'); \
      if openssl x509 -in "$f" -noout >/dev/null 2>&1; then \
        cp "$f" "/usr/local/share/ca-certificates/$name.crt"; \
      else \
        openssl x509 -inform DER -in "$f" -out "/usr/local/share/ca-certificates/$name.crt"; \
      fi; \
    done; \
    update-ca-certificates; \
    cat /usr/local/share/ca-certificates/russian_trusted_root_ca.crt /etc/ssl/certs/ca-certificates.crt > /etc/ssl/certs/max-ca-bundle.pem; \
    rm -rf /tmp/max-ca /tmp/russian_trusted_sub_ca.zip

ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/max-ca-bundle.pem
ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app
COPY server.js /app/server.js

EXPOSE 8080
CMD ["node", "/app/server.js"]
