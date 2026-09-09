# The oracle loop: runs the attention-index workflow in the CRE simulator with --broadcast on the
# config's schedule, standing in for the CRE DON on Testnet. Build from the repository root:
#   docker build -f apps/cre-oracle/Dockerfile .
FROM oven/bun:1.4.2-slim

# The CRE CLI, pinned and checksum-verified. The base is Debian trixie (glibc 2.41), so it takes the
# standard Linux build rather than the ldd2-35 one.
ARG CRE_VERSION=v1.35.0
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in \
      amd64) sha=11e6d2ecf3292505268442fd55a48c44da2e0b3b1b647a6cee25a67e8965f844 ;; \
      arm64) sha=875655a9bb4f1b2eaab2f19d710df9122aa24b4ce49b687421befdcf2bf70d7b ;; \
      *) echo "no CRE CLI build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && name="cre_${CRE_VERSION}_linux_${TARGETARCH:-amd64}" \
 && bun -e "await Bun.write('/tmp/cre.tar.gz', await fetch('https://github.com/smartcontractkit/cre-cli/releases/download/${CRE_VERSION}/cre_linux_${TARGETARCH:-amd64}.tar.gz'))" \
 && echo "${sha}  /tmp/cre.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/cre.tar.gz -C /tmp "${name}" \
 && install -m 0755 "/tmp/${name}" /usr/local/bin/cre \
 && rm -f /tmp/cre.tar.gz "/tmp/${name}"

# The loop reads contracts/deployments to check the workflow config, so the layout mirrors the repo.
WORKDIR /repo/apps/cre-oracle
COPY apps/cre-oracle/attention-index/package.json apps/cre-oracle/attention-index/bun.lock attention-index/
# All dependencies: the CLI type-checks the workflow with TypeScript when it compiles it.
RUN cd attention-index && bun install --frozen-lockfile
COPY apps/cre-oracle/ ./
COPY contracts/deployments /repo/contracts/deployments

# The CLI keeps its session in ~/.cre, linked to the volume at /data (see scripts/container-start.sh).
# HOME is fixed so the same paths hold when the platform runs the image as root for the volume.
ENV HOME=/home/bun NODE_ENV=production
RUN mkdir -p /data/cre /home/bun && ln -s /data/cre /home/bun/.cre \
 && chown -R bun:bun /data /home/bun /repo/apps/cre-oracle
USER bun
# Fetches the pinned Javy compiler into ~/.cache and proves the workflow compiles, so a run never
# downloads a compiler.
RUN cre workflow build attention-index --target testnet -o /tmp/attention-index.wasm && rm /tmp/attention-index.wasm

EXPOSE 4600
CMD ["sh", "scripts/container-start.sh"]
