FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libglib2.0-0 libgl1 tzdata && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt requirements-models.txt requirements-segmentation.txt requirements-review.txt requirements-pose3d.txt requirements-vision-action.txt ./
RUN pip install --no-cache-dir -r requirements.txt
ARG WITH_POSE=false
RUN if [ "$WITH_POSE" = "true" ]; then pip install --no-cache-dir -r requirements-models.txt; fi
ARG WITH_SEGMENTATION=false
RUN if [ "$WITH_SEGMENTATION" = "true" ]; then pip install --no-cache-dir -r requirements-segmentation.txt; fi
ARG WITH_REVIEW=false
RUN if [ "$WITH_REVIEW" = "true" ]; then pip install --no-cache-dir -r requirements-review.txt; fi
ARG WITH_POSE3D=false
RUN if [ "$WITH_POSE3D" = "true" ]; then pip install --no-cache-dir -r requirements-pose3d.txt; fi
ARG WITH_ACTION=false
RUN if [ "$WITH_ACTION" = "true" ]; then pip install --no-cache-dir -r requirements-vision-action.txt; fi
COPY arena/ ./arena/
COPY scripts/ ./scripts/
COPY --from=frontend /build/dist/ ./frontend/dist/
RUN useradd --create-home --uid 10001 arena && mkdir -p /app/data /app/models && chown -R arena:arena /app
USER arena
ENV ARENA_DATA_DIR=/app/data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=3)" || exit 1
CMD ["uvicorn", "arena.api:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
