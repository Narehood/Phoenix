# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS web
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*
RUN npm install --global npm@12.2.2 --ignore-scripts --no-audit --no-fund
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM golang:1.27.3-trixie@sha256:af1bfc2614ebb1dbd31af514b78740fd678850e76498762b425ecee4c5c6ea80 AS go-base
ENV CGO_ENABLED=1
RUN apt-get update && apt-get upgrade -y --no-install-recommends && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
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
RUN --network=none CGO_ENABLED=1 python3 scripts/validate.py --timeout 300 -- go test -race -count=1 -timeout=120s ./internal/agent ./internal/canary ./internal/github ./internal/security ./cmd/phoenix-helper
# Keep the bcrypt-heavy server fixtures in complementary sequential batches;
# each retains the original per-package deadline and guarded storage budgets.
RUN --network=none CGO_ENABLED=1 python3 scripts/validate.py --timeout 300 -- go test -race -count=1 -timeout=120s -run '^Test(GitHub|Project)' ./internal/server
RUN --network=none CGO_ENABLED=1 python3 scripts/validate.py --timeout 300 -- go test -race -count=1 -timeout=120s -skip '^Test(GitHub|Project)' ./internal/server

FROM validate AS binaries
RUN python3 scripts/validate.py --timeout 300 -- python3 scripts/check.py binaries

FROM binaries AS smoke
ENV HOME=/tmp
RUN chown -R 10001:10001 /src/.validation
USER 10001:10001
RUN --network=none python3 scripts/validate.py --timeout 120 -- python3 scripts/smoke.py

FROM scratch AS agent-artifacts
COPY --from=smoke /src/bin/phoenix-agent /phoenix-agent
COPY --from=smoke /src/bin/phoenix-helper /phoenix-helper

FROM scratch AS test-kit
COPY --from=smoke /src/bin/ /bin/
COPY --from=smoke /src/web-dist/ /web/
COPY deploy/server.example.json deploy/agent.example.json deploy/helper.example.json deploy/phoenix-agent.service deploy/phoenix-agent.sudoers /deploy/
COPY docs/architecture.md docs/canary.md docs/github.md docs/milestone.md docs/operations.md docs/project-maintenance.md docs/protocol.md docs/testing.md docs/threat-model.md docs/validation.md /docs/
COPY README.md /README.md

FROM debian:13-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS server
RUN apt-get update && apt-get upgrade -y --no-install-recommends && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/phoenix /var/lib/phoenix-identity /etc/phoenix \
    && chown 10001:10001 /var/lib/phoenix /var/lib/phoenix-identity
COPY --from=smoke /src/bin/phoenix /usr/local/bin/phoenix
COPY --from=smoke /src/web-dist/ /usr/share/phoenix/web/
USER 10001:10001
EXPOSE 8443 9443
ENTRYPOINT ["/usr/local/bin/phoenix"]
CMD ["serve", "-config", "/etc/phoenix/server.json"]
