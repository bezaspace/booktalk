# ---- Stage 1: Build the React frontend ----
FROM node:20-slim AS frontend-build

WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci || npm install
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: Python backend + built frontend ----
FROM python:3.11-slim AS runtime

# Install uv for fast dependency resolution
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# Copy entire build context
COPY . /tmp/src/

# Set up backend: install deps and copy source
RUN cp -r /tmp/src/backend/. /app/backend/
RUN cd /app/backend && uv sync --frozen --no-dev 2>&1 | tail -n 20 || cd /app/backend && uv sync --no-dev
# Keep app import path compatible: /app/app -> mirrors raksha layout for tooling, but also /app/backend/app is used by uv run
RUN mkdir -p /app/app && cp -r /app/backend/app/* /app/app/ 2>/dev/null || true

# Copy built frontend into the location the backend expects
COPY --from=frontend-build /build/dist/ /app/frontend_dist/

# Clean up temp
RUN rm -rf /tmp/src

# Create /storage for ONCE-compatible persistent data (even if not used, required by ONCE spec)
RUN mkdir -p /storage
VOLUME /storage

# ONCE requires the app to serve HTTP on port 80
EXPOSE 80

# Environment defaults (GEMINI_API_KEY must be provided at deploy time)
ENV HOST=0.0.0.0 \
    PORT=80 \
    FRONTEND_ORIGIN=* \
    LOG_LEVEL=info \
    PYTHONUNBUFFERED=1 \
    BOOKTALK_FRONTEND_DIST=/app/frontend_dist \
    FRONTEND_DIST=/app/frontend_dist

# Healthcheck: ONCE polls /up (and /health)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:80/up')" || exit 1

# Run the backend, which now serves both the API and the static frontend
CMD ["uv", "run", "--directory", "backend", "uvicorn", "app.main:app", \
     "--host", "0.0.0.0", "--port", "80", \
     "--ws-ping-interval", "20", "--ws-ping-timeout", "20", "--timeout-keep-alive", "30"]
