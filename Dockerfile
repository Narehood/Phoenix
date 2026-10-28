# syntax=docker/dockerfile:1.7
FROM node:24.22.1-bookworm-slim AS web
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM golang:1.27.3-bookworm AS go-base
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY --from=web /src/web/dist/ /src/web-dist/
COPY go.mod go.sum ./
COPY scripts/ scripts/
RUN python3 scripts/validate.py --timeout 240 -- go mod download
COPY cmd/ cmd/
COPY internal/ internal/

# All runtime tests use loopback fixtures. No workstation executables or real
# service/reboot commands are used. The execution layer has no external network.
FROM go-base AS validate
RUN --network=none python3 scripts/validate.py --timeout 300 -- python3 scripts/check.py tests
RUN --network=none python3 scripts/validate.py --timeout 180 -- python3 scripts/check.py vet
RUN --network=none CGO_ENABLED=1 python3 scripts/validate.py --timeout 300 -- go test -race -count=1 -timeout=120s ./internal/agent ./internal/canary ./internal/security ./internal/server

FROM validate AS binaries
RUN CGO_ENABLED=0 python3 scripts/validate.py --timeout 300 -- python3 scripts/check.py binaries

FROM scratch AS agent-artifacts
COPY --from=binaries /src/bin/phoenix-agent /phoenix-agent
COPY --from=binaries /src/bin/phoenix-helper /phoenix-helper

FROM debian:13-slim AS server
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/phoenix /var/lib/phoenix-identity /etc/phoenix \
    && chown 10001:10001 /var/lib/phoenix /var/lib/phoenix-identity
COPY --from=binaries /src/bin/phoenix /usr/local/bin/phoenix
COPY --from=binaries /src/web-dist/ /usr/share/phoenix/web/
USER 10001:10001
EXPOSE 8443 9443
ENTRYPOINT ["/usr/local/bin/phoenix"]
CMD ["serve", "-config", "/etc/phoenix/server.json"]
