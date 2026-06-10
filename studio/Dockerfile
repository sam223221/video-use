# ===========================================================================
#  video-use Studio - Docker image (API-KEY run path)
#
#  BUILD CONTEXT = REPO ROOT (so the helpers/, SKILL.md, pyproject.toml outside
#  studio/ can be copied in). Build via docker-compose (context: ..) or:
#     docker build -f studio/Dockerfile -t video-use-studio .
#
#  In this run path the agent uses a pay-as-you-go ANTHROPIC_API_KEY (provided
#  via the repo .env / compose env_file), NOT the Claude MAX subscription. ffmpeg
#  here is the Debian apt build (CPU-only) - renders are slower than native.
#
#  Multi-stage: a builder installs deps into a venv; the slim runtime copies the
#  venv + app and runs as a non-root user.
# ===========================================================================

# Pinned tag (digest pinning left to CI; bookworm has ffmpeg in apt and 3.14
# wheels are available - verified Phase 0).
FROM python:3.14-slim-bookworm AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /build

# Build the venv with just the studio requirements first (better layer caching:
# this layer only busts when requirements.txt changes).
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY studio/requirements.txt /build/studio/requirements.txt
RUN pip install --upgrade pip && \
    pip install -r /build/studio/requirements.txt

# Now bring in the package metadata + helpers and editable-install video-use so
# the helper scripts + package import correctly in-container.
COPY pyproject.toml LICENSE /build/
COPY helpers/ /build/helpers/
COPY SKILL.md /build/SKILL.md
COPY studio/ /build/studio/
RUN pip install -e /build


# --- runtime stage --------------------------------------------------------
FROM python:3.14-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    STUDIO_HOST=0.0.0.0 \
    STUDIO_PORT=8420 \
    # In docker mode the only allowed browse/footage root is the mounted volume.
    STUDIO_ALLOWED_ROOTS=/footage

# ffmpeg + ffprobe from Debian apt (CPU-only). Pinned to the distro's package;
# --no-install-recommends keeps the image small.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Non-root user (ARCHITECTURE.md / quality bar: never run as root).
RUN groupadd --gid 10001 studio && \
    useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin studio

# Copy the prepared venv and the editable-installed source tree from the builder.
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /build /app

# The footage mount point (declared in compose); created so it exists pre-mount.
RUN mkdir -p /footage && chown -R studio:studio /app /footage

WORKDIR /app/studio
USER studio

EXPOSE 8420

# Lightweight healthcheck: /api/status requires the session cookie (returns 401
# without login), so the healthcheck probes the public SPA shell at "/" (the
# ungated index route) for a 200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8420/', timeout=4).status==200 else 1)" || exit 1

# app.main:app is importable because WORKDIR is /app/studio (so 'app' resolves).
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8420"]
