FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY src ./src
RUN uv sync --frozen --no-dev
ENV PATH="/app/.venv/bin:$PATH"
CMD ["python", "-m", "intelligence"]
